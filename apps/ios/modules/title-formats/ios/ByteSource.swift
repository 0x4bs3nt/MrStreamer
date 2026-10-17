import Foundation

/// Why a session's file stopped coming, as the app classifies it. Never an address or the
/// system's own words, which can quote one.
enum SessionFailure {
  /// The provider answered with this HTTP status.
  case status(Int)
  case network(String)
  case unsupported(String)

  var record: [String: Any] {
    switch self {
    case .status(let status): return ["kind": "status", "status": status]
    case .network(let detail): return ["kind": "network", "detail": detail]
    case .unsupported(let detail): return ["kind": "unsupported", "detail": detail]
    }
  }
}

/// The bytes of one file, read by the C core from its work queue, a read at a time.
protocol ByteSource: AnyObject {
  /// The file's size, once `prepare` returned; -1 when unknown.
  var size: Int64 { get }
  var failure: SessionFailure? { get }
  /// Starts reading at the file's start, and waits for the answer. False when it failed.
  func prepare() -> Bool
  /// Reads up to `count` bytes at `offset`: the bytes read, 0 at the end, -1 on failure or close.
  func read(at offset: Int64, into buffer: UnsafeMutablePointer<UInt8>, count: Int) -> Int
  /// Stops: a waiting read returns -1, and nothing more is asked of the file.
  func close()
  /// Runs `ended` once, when nothing of the file is being read any more after `close`.
  func whenEnded(_ ended: @escaping () -> Void)
}

/// A downloaded copy, read from the phone.
final class CopyBytes: ByteSource {
  private let handle: FileHandle?
  private let lock = NSLock()
  private var closed = false
  let size: Int64
  private(set) var failure: SessionFailure?

  init(path: String) {
    handle = FileHandle(forReadingAtPath: path)
    let attributes = try? FileManager.default.attributesOfItem(atPath: path)
    size = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
    if handle == nil { failure = .status(404) }
  }

  func prepare() -> Bool { handle != nil }

  func read(at offset: Int64, into buffer: UnsafeMutablePointer<UInt8>, count: Int) -> Int {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, let handle else { return -1 }
    do {
      try handle.seek(toOffset: UInt64(offset))
      guard let data = try handle.read(upToCount: count) else { return 0 }
      data.copyBytes(to: buffer, count: data.count)
      return data.count
    } catch {
      failure = .unsupported("The copy on this phone can't be read.")
      return -1
    }
  }

  func close() {
    lock.lock()
    closed = true
    try? handle?.close()
    lock.unlock()
  }

  func whenEnded(_ ended: @escaping () -> Void) { ended() }
}

/// What happened to one request to the provider, for the native proof: where it asked from
/// and when, in milliseconds since the session began. No address.
struct RequestTrace {
  let offset: Int64
  let sent: Int
  var answered: Int?
  var status: Int?
  var cancelled: Int?
  var ended: Int?
  var bytes: Int64 = 0
  var outcome = ""

  var record: [String: Any] {
    var out: [String: Any] = ["offset": offset, "sent": sent, "bytes": bytes, "outcome": outcome]
    if let answered { out["answered"] = answered }
    if let status { out["status"] = status }
    if let cancelled { out["cancelled"] = cancelled }
    if let ended { out["ended"] = ended }
    return out
  }
}

/// A provider's file, over one connection: at most one request is open at a time, and a new one
/// is sent only once URLSession said the last one ended. A read near where the last stopped
/// carries on with the request that is open. Its body is taken as it is read, up to a bound.
///
/// Each request has a URLSession of its own. With one session limited to one connection per
/// host, a request sent right after another was cancelled waited seconds on the simulator before
/// it went out; the order of requests is kept here instead, so no session holds a slot.
final class ProviderBytes: NSObject, ByteSource, URLSessionDataDelegate {
  /// What the open request may hold unread before it is paused, and resumed below `low`. A move
  /// elsewhere in the file throws away at most this much.
  private static let high = 4 << 20
  private static let low = 1 << 20
  /// A read this far past the bytes received waits for them rather than asking again.
  private static let reach: Int64 = 512 << 10
  /// Requests that dropped one after another, with nothing received between, before giving up.
  private static let drops = 2

  private let url: URL
  private let headers: [String: String]
  private let condition = NSCondition()
  private let began = Date()
  private let queue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private var session: URLSession?
  private var task: URLSessionDataTask?
  /// A request whose end URLSession hasn't told yet.
  private var open = false
  private var answered = false
  private var finished = false
  /// The request that finished ended early: by an error, or before the end of the file.
  private var dropped = false
  private var dropsInRow = 0
  private var paused = false
  /// The open request is being cancelled: what it still delivers is dropped.
  private var stopping = false
  private var closed = false
  /// The file offset of `bytes[head]`.
  private var start: Int64 = 0
  private var bytes: [UInt8] = []
  private var head = 0
  private var ended: [() -> Void] = []
  private(set) var size: Int64 = -1
  private(set) var failure: SessionFailure?
  private var trace: [RequestTrace] = []
  /// The requests so far, read under the lock.
  var traced: [RequestTrace] {
    condition.lock()
    defer { condition.unlock() }
    return trace
  }

  init(url: URL, headers: [String: String]) {
    self.url = url
    self.headers = headers
    super.init()
  }

  private var now: Int { Int(Date().timeIntervalSince(began) * 1000) }

  func prepare() -> Bool {
    condition.lock()
    defer { condition.unlock() }
    // Closed already, its end told: nothing more is asked of the provider.
    if closed { return false }
    begin(at: 0)
    while !answered && failure == nil && !closed { condition.wait() }
    return answered && failure == nil && !closed
  }

  /// Sends a request for the file from `offset`; the lock is held and no request is open.
  private func begin(at offset: Int64) {
    var request = URLRequest(url: url)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range")
    start = offset
    bytes.removeAll(keepingCapacity: true)
    head = 0
    answered = false
    finished = false
    dropped = false
    paused = false
    stopping = false
    open = true
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let made = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    session = made
    let next = made.dataTask(with: request)
    task = next
    trace.append(RequestTrace(offset: offset, sent: now))
    next.resume()
  }

  private var available: Int { bytes.count - head }

  func read(at offset: Int64, into buffer: UnsafeMutablePointer<UInt8>, count: Int) -> Int {
    condition.lock()
    defer { condition.unlock() }
    while true {
      if closed || failure != nil { return -1 }
      if size >= 0 && offset >= size { return 0 }
      let end = start + Int64(available)
      if task != nil && offset >= start && offset <= end + (finished ? 0 : Self.reach) {
        if offset <= end {
          head += Int(offset - start)
          start = offset
          if available > 0 {
            let taken = min(count, available)
            bytes.withUnsafeBufferPointer { all in
              buffer.update(from: all.baseAddress! + head, count: taken)
            }
            head += taken
            start += Int64(taken)
            if head > Self.low {
              bytes.removeFirst(head)
              head = 0
            }
            if paused && available < Self.low {
              paused = false
              task?.resume()
            }
            return taken
          }
          if finished {
            // The body is over here: the end of the file, else a drop to go on from.
            if !dropped && (size < 0 || offset >= size) { return 0 }
            if dropsInRow >= Self.drops {
              failure = .network(Self.describe(lastError))
              return -1
            }
            dropsInRow += 1
            begin(at: offset)
            continue
          }
        }
        // Nothing here to read yet: the offset is at the end of what was received, of a request
        // still sending, or a little further on. What was received before it isn't needed, and a
        // request paused because nothing read it goes on, else the wait would never end.
        bytes.removeAll(keepingCapacity: true)
        head = 0
        start = end
        if paused {
          paused = false
          task?.resume()
        }
        condition.wait()
        continue
      }
      // Elsewhere in the file: the open request ends first, then one goes out from here.
      if open {
        stopTask()
        while open { condition.wait() }
        if closed { return -1 }
      }
      begin(at: offset)
    }
  }

  /// Cancels the open request. A suspended task reports its end only once resumed, which took
  /// seconds on the simulator, so it is resumed first; the lock is held.
  private func stopTask() {
    stopping = true
    if trace.indices.last.map({ trace[$0].cancelled == nil }) == true { trace[trace.count - 1].cancelled = now }
    if paused {
      paused = false
      task?.resume()
    }
    task?.cancel()
  }

  func close() {
    condition.lock()
    closed = true
    if open { stopTask() }
    let done = !open ? takeEnded() : []
    condition.broadcast()
    condition.unlock()
    done.forEach { $0() }
  }

  func whenEnded(_ then: @escaping () -> Void) {
    condition.lock()
    if closed && !open {
      condition.unlock()
      then()
      return
    }
    ended.append(then)
    condition.unlock()
  }

  /// The callbacks waiting for the end, once; the lock is held.
  private func takeEnded() -> [() -> Void] {
    let waiting = ended
    ended = []
    return waiting
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    condition.lock()
    defer {
      condition.broadcast()
      condition.unlock()
    }
    guard dataTask === task, !closed, !stopping, let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    trace[trace.count - 1].answered = now
    trace[trace.count - 1].status = http.statusCode
    switch http.statusCode {
    case 206:
      // "bytes <first>-<last>/<size>": it must start where it was asked.
      let range = (http.value(forHTTPHeaderField: "Content-Range") ?? "")
        .replacingOccurrences(of: "bytes ", with: "")
      let parts = range.split(whereSeparator: { $0 == "-" || $0 == "/" })
      guard parts.count == 3, Int64(parts[0]) == start else {
        failure = .unsupported("The provider sent another part of the file than asked.")
        completionHandler(.cancel)
        return
      }
      if let total = Int64(parts[2]) { size = total }
    case 200 where start == 0:
      size = response.expectedContentLength
    case 200, 416:
      // Without parts of the file, nothing can seek in it; nothing is read in full instead.
      failure = .unsupported("The provider doesn't send part of a file, which seeking needs.")
      completionHandler(.cancel)
      return
    default:
      failure = .status(http.statusCode)
      completionHandler(.cancel)
      return
    }
    answered = true
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    condition.lock()
    defer {
      condition.broadcast()
      condition.unlock()
    }
    guard dataTask === task, !stopping else { return }
    bytes.append(contentsOf: data)
    trace[trace.count - 1].bytes += Int64(data.count)
    dropsInRow = 0
    if available > Self.high && !paused {
      paused = true
      dataTask.suspend()
    }
  }

  func urlSession(_ session: URLSession, task ended: URLSessionTask, didCompleteWithError error: Error?) {
    condition.lock()
    var done: [() -> Void] = []
    if ended === task {
      open = false
      finished = true
      trace[trace.count - 1].ended = now
      let error = error as NSError?
      if stopping || closed {
        trace[trace.count - 1].outcome = "cancelled"
      } else if failure != nil {
        // The answer was refused already, and cancelling it ended the task: its failure stands.
        trace[trace.count - 1].outcome = "refused"
      } else if let error, !answered {
        failure = .network(Self.describe(error.code))
        trace[trace.count - 1].outcome = "failed \(error.code)"
      } else if let error {
        // A drop: the next read goes on from where it stopped.
        dropped = true
        trace[trace.count - 1].outcome = "dropped \(error.code)"
        lastError = error.code
      } else {
        trace[trace.count - 1].outcome = "finished"
        dropped = size >= 0 && start + Int64(available) < size
        if dropped { lastError = 0 }
      }
      session.finishTasksAndInvalidate()
      if closed { done = takeEnded() }
    }
    condition.broadcast()
    condition.unlock()
    done.forEach { $0() }
  }

  /// The system's code for the last drop, 0 for a body that ended early without one.
  private var lastError = 0

  /// A network failure in fixed words: the system's own can quote the address.
  static func describe(_ code: Int) -> String {
    switch code {
    case NSURLErrorTimedOut: return "The provider didn't answer in time."
    case NSURLErrorNetworkConnectionLost: return "The connection dropped."
    case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed: return "This device is offline."
    case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "The provider's server can't be found."
    case NSURLErrorCannotConnectToHost: return "The provider's server refused the connection."
    case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted,
      NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid,
      NSURLErrorServerCertificateHasUnknownRoot:
      return "The secure connection to the provider failed."
    case 0: return "The connection kept ending early."
    default: return "Network error \(code)."
    }
  }
}
