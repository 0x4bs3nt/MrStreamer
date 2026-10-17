import Foundation

/// One file played through the C core: its source, its title and its route on the loopback
/// server. Everything of the title runs on `work`, one request at a time, including AVPlayer's
/// requests for the picture and each sound track, which the core makes in one pass and keeps,
/// bounded, until they are asked for; the source's reads block there while URLSession answers on
/// a queue of its own.
final class FormatSession {
  enum Opened {
    case session(playlist: String)
    case direct
    case failed(SessionFailure)
    case closed
  }

  private let work = DispatchQueue(label: "app.mrstreamer.title-formats.session")
  private let lock = NSLock()
  private let source: ByteSource
  private let token: String
  /// Where playback starts, in seconds of the title.
  private let start: Double
  private var title: OpaquePointer?
  private var closed = false
  private var failure_: SessionFailure?
  private var sourceEnded = false
  private var titleFreed = false
  private var finished: [() -> Void] = []
  /// Told, once and on the work queue, when a session that opened stops serving: AVPlayer
  /// needn't report an error for a request that failed, and may wait instead.
  private let failed: (SessionFailure) -> Void

  init(
    url: URL, headers: [String: String], start: Double,
    failed: @escaping (SessionFailure) -> Void
  ) {
    source = url.isFileURL ? CopyBytes(path: url.path) : ProviderBytes(url: url, headers: headers)
    self.start = start
    self.failed = failed
    var random = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, random.count, &random)
    token = random.map { String(format: "%02x", $0) }.joined()
    source.whenEnded { [weak self] in self?.ended(source: true) }
  }

  var failure: SessionFailure? {
    lock.lock()
    defer { lock.unlock() }
    return failure_ ?? source.failure
  }

  /// The provider requests so far, without their address; none for a copy.
  var trace: [[String: Any]] {
    (source as? ProviderBytes).map { provider in provider.traced.map(\.record) } ?? []
  }

  /// Stops serving for `failure`, the first one only, and says so unless the session closed.
  private func fail(_ failure: SessionFailure) {
    lock.lock()
    let first = failure_ == nil
    if first { failure_ = failure }
    let tell = first && !closed
    lock.unlock()
    if tell { failed(failure) }
  }

  /// Reads the file's header and index, then serves it. Calls `done` on the work queue.
  func open(_ done: @escaping (Opened) -> Void) {
    work.async { [self] in
      guard !isClosed, source.prepare() else {
        return done(isClosed ? .closed : .failed(failure ?? .network(ProviderBytes.describe(0))))
      }
      var callbacks = TitleHlsSource()
      callbacks.opaque = Unmanaged.passUnretained(self).toOpaque()
      callbacks.size = source.size
      callbacks.read_at = { opaque, offset, buffer, size in
        let session = Unmanaged<FormatSession>.fromOpaque(opaque!).takeUnretainedValue()
        return Int32(session.source.read(at: offset, into: buffer!, count: Int(size)))
      }
      var made: OpaquePointer?
      var detail = [CChar](repeating: 0, count: 256)
      let result = title_hls_open(&callbacks, start, &made, &detail, detail.count)
      lock.lock()
      let stopped = closed
      if !stopped { title = made }
      lock.unlock()
      if stopped {
        if let made { title_hls_close(made) }
        return done(.closed)
      }
      if result == TITLE_HLS_OK {
        do {
          let port = try LoopbackServer.shared.start()
          LoopbackServer.shared.add(token) { [weak self] name, respond in
            guard let self else { return respond(.missing) }
            self.work.async { respond(self.answer(name)) }
          }
          return done(.session(playlist: "http://127.0.0.1:\(port)/\(token)/main.m3u8"))
        } catch {
          return done(.failed(.unsupported("The player's local server didn't start.")))
        }
      }
      switch result {
      case TITLE_HLS_DIRECT: done(.direct)
      case TITLE_HLS_INTERRUPTED: done(.closed)
      case TITLE_HLS_READ_FAILED: done(.failed(failure ?? .network(ProviderBytes.describe(0))))
      default: done(.failed(.unsupported(String(cString: detail))))
      }
    }
  }

  private var isClosed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return closed
  }

  /// One of AVPlayer's requests, on the work queue.
  private func answer(_ name: String) -> LoopbackResponse {
    guard !isClosed, let title else { return .missing }
    var data: UnsafePointer<UInt8>?
    var size = 0
    var type: UnsafePointer<CChar>?
    var detail = [CChar](repeating: 0, count: 256)
    let result = title_hls_get(title, name, &data, &size, &type, &detail, detail.count)
    switch result {
    case TITLE_HLS_OK:
      let body = data.map { Data(bytes: $0, count: size) } ?? Data()
      return LoopbackResponse(status: 200, type: type.map { String(cString: $0) } ?? "video/mp4", body: body)
    case TITLE_HLS_MISSING:
      return .missing
    case TITLE_HLS_READ_FAILED:
      fail(source.failure ?? .network(ProviderBytes.describe(0)))
    case TITLE_HLS_UNSUPPORTED:
      fail(.unsupported(String(cString: detail)))
    case TITLE_HLS_NO_MEMORY:
      fail(.unsupported("This part of the file is too large to play from memory."))
    default:
      break
    }
    return .failed
  }

  /// Stops serving and reading at once; the title is freed once its work queue is free.
  func close() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    let title = self.title
    lock.unlock()
    LoopbackServer.shared.remove(token)
    if let title { title_hls_interrupt(title) }
    source.close()
    work.async { [self] in
      lock.lock()
      let title = self.title
      self.title = nil
      lock.unlock()
      if let title { title_hls_close(title) }
      ended(source: false)
    }
  }

  /// Calls `then` once the provider's request ended and the title is freed, after `close`.
  func whenClosed(_ then: @escaping () -> Void) {
    lock.lock()
    if sourceEnded && titleFreed {
      lock.unlock()
      return then()
    }
    finished.append(then)
    lock.unlock()
  }

  private func ended(source: Bool) {
    lock.lock()
    if source { sourceEnded = true } else { titleFreed = true }
    let done = sourceEnded && titleFreed ? finished : []
    if sourceEnded && titleFreed { finished = [] }
    lock.unlock()
    done.forEach { $0() }
  }
}
