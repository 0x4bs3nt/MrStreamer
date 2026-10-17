import Darwin
import Foundation

/// An answer to one request of AVPlayer's.
struct LoopbackResponse {
  let status: Int
  let type: String
  let body: Data

  static let missing = LoopbackResponse(status: 404, type: "text/plain", body: Data())
  static let failed = LoopbackResponse(status: 500, type: "text/plain", body: Data())
}

/// The HTTP server AVPlayer streams sessions from: a socket bound to 127.0.0.1 only, GET and
/// HEAD, each session under an unguessable path of its own, removed when it closes. Nothing it
/// serves carries a login.
///
/// A BSD socket rather than Network's NWListener, which in the iOS 27 simulator reported ready
/// and never delivered a connection. Each connection reads and answers on a queue of its own;
/// AVPlayer opens a few at most.
final class LoopbackServer {
  static let shared = LoopbackServer()

  typealias Handler = (_ name: String, _ respond: @escaping (LoopbackResponse) -> Void) -> Void

  private let lock = NSLock()
  private var listening: Int32 = -1
  private var port: UInt16 = 0
  private var source: DispatchSourceRead?
  private var routes: [String: Handler] = [:]

  /// The listening port, starting the server if it isn't running.
  func start() throws -> UInt16 {
    lock.lock()
    defer { lock.unlock() }
    if listening >= 0 { return port }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw NSError(domain: "TitleFormats", code: Int(errno)) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    var named = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let found = withUnsafeMutablePointer(to: &named) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    guard bound == 0, listen(fd, 16) == 0, found == 0 else {
      let code = errno
      close(fd)
      throw NSError(domain: "TitleFormats", code: Int(code))
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    let accepting = DispatchSource.makeReadSource(
      fileDescriptor: fd, queue: DispatchQueue(label: "app.mrstreamer.title-formats.accept"))
    accepting.setEventHandler { [weak self] in self?.accept(fd) }
    accepting.setCancelHandler { close(fd) }
    accepting.resume()
    listening = fd
    port = UInt16(bigEndian: named.sin_port)
    source = accepting
    return port
  }

  func add(_ token: String, _ handler: @escaping Handler) {
    lock.lock()
    routes[token] = handler
    lock.unlock()
  }

  func remove(_ token: String) {
    lock.lock()
    routes[token] = nil
    lock.unlock()
  }

  private func handler(for token: String) -> Handler? {
    lock.lock()
    defer { lock.unlock() }
    return routes[token]
  }

  /// Takes every connection waiting; a listening socket that failed is let go, so the next
  /// session starts another.
  private func accept(_ fd: Int32) {
    while true {
      let client = Darwin.accept(fd, nil, nil)
      if client < 0 {
        if errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR { stopListening(fd) }
        return
      }
      var on: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      // An accepted socket inherits the listening socket's O_NONBLOCK; its reads here block.
      _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
      DispatchQueue(label: "app.mrstreamer.title-formats.connection").async { [weak self] in
        self?.serve(client)
        close(client)
      }
    }
  }

  private func stopListening(_ fd: Int32) {
    lock.lock()
    if listening == fd {
      source?.cancel()
      source = nil
      listening = -1
    }
    lock.unlock()
  }

  /// Answers requests on one connection until AVPlayer closes it.
  private func serve(_ client: Int32) {
    var pending = Data()
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      while pending.range(of: Data("\r\n\r\n".utf8)) == nil {
        let read = chunk.withUnsafeMutableBytes { recv(client, $0.baseAddress, $0.count, 0) }
        if read <= 0 || pending.count > 64 * 1024 { return }
        pending.append(contentsOf: chunk[0..<read])
      }
      let end = pending.range(of: Data("\r\n\r\n".utf8))!
      let head = String(decoding: pending[pending.startIndex..<end.lowerBound], as: UTF8.self)
      pending = Data(pending[end.upperBound...])
      guard send(answer(head), to: client) else { return }
    }
  }

  private func send(_ data: Data, to client: Int32) -> Bool {
    data.withUnsafeBytes { all in
      var sent = 0
      while sent < all.count {
        let wrote = Darwin.send(client, all.baseAddress! + sent, all.count - sent, 0)
        if wrote <= 0 { return false }
        sent += wrote
      }
      return true
    }
  }

  /// One range of "bytes=<first>-[<last>]", or nil for anything else: a suffix, several ranges,
  /// a reversed or unrepresentable one. A request with such a Range gets the whole body, as HTTP
  /// lets a server ignore a Range it doesn't take.
  static func range(_ value: String) -> (first: Int, last: Int?)? {
    guard value.hasPrefix("bytes=") else { return nil }
    let bounds = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
    let digits = { (text: Substring) in !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber } }
    guard bounds.count == 2, digits(bounds[0]), let first = Int(bounds[0]) else { return nil }
    if bounds[1].isEmpty { return (first, nil) }
    guard digits(bounds[1]), let last = Int(bounds[1]), last >= first else { return nil }
    return (first, last)
  }

  /// The whole response to one request: the session it names answers, on its own queue.
  private func answer(_ head: String) -> Data {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    let method = parts.first.map(String.init) ?? ""
    let path = parts.count > 1 ? (parts[1].split(separator: "?").first.map(String.init) ?? "") : ""
    let segments = path.split(separator: "/").map(String.init)
    var range: (first: Int, last: Int?)?
    for line in lines.dropFirst() where line.lowercased().hasPrefix("range:") {
      range = Self.range(line.dropFirst(6).trimmingCharacters(in: .whitespaces))
    }
    var response = LoopbackResponse.missing
    if method == "GET" || method == "HEAD", segments.count == 2,
      let handler = handler(for: segments[0])
    {
      let answered = DispatchSemaphore(value: 0)
      handler(segments[1]) {
        response = $0
        answered.signal()
      }
      answered.wait()
    }
    var body = response.body
    var status = response.status
    var headers = ["Content-Type: \(response.type)", "Accept-Ranges: bytes"]
    if let range, status == 200 {
      if range.first < body.count {
        let last = min(range.last ?? body.count - 1, body.count - 1)
        headers.append("Content-Range: bytes \(range.first)-\(last)/\(body.count)")
        body = body.subdata(in: range.first..<(last + 1))
        status = 206
      } else {
        headers.append("Content-Range: bytes */\(body.count)")
        body = Data()
        status = 416
      }
    }
    headers.append("Content-Length: \(body.count)")
    let reason =
      [200: "OK", 206: "Partial Content", 404: "Not Found", 416: "Range Not Satisfiable"][status]
      ?? "Error"
    var out = Data("HTTP/1.1 \(status) \(reason)\r\n\(headers.joined(separator: "\r\n"))\r\n\r\n".utf8)
    if method != "HEAD" { out.append(body) }
    return out
  }
}
