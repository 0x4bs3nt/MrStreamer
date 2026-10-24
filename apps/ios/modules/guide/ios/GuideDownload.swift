import Foundation

/** URLSession callback bytes are bounded. They may already be HTTP-decoded, not wire bytes. */
final class GuideDownload: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  private let job: GuideJob
  private let file: URL
  private let disk: GuideDisk
  private let done = DispatchSemaphore(value: 0)
  private var handle: FileHandle?
  private var count: Int64 = 0
  private var failure: String?
  private var redirect: String?
  private var status = 0
  init(job: GuideJob, file: URL, disk: GuideDisk) { self.job = job; self.file = file; self.disk = disk }
  func run(_ address: String, _ headers: [String: String]) throws -> String? {
    guard let url = URL(string: address), ["http", "https"].contains(url.scheme ?? "") else { throw GuideFailure("redirect") }
    try job.check(); try disk.check()
    handle = try disk.open(file)
    defer { try? handle?.close(); try? FileManager.default.removeItem(at: file) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil; configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil; configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 180; configuration.timeoutIntervalForResource = 180
    let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; queue.qualityOfService = .utility
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    let task = session.dataTask(with: request); job.setTask(task); task.resume()
    while done.wait(timeout: .now() + 0.05) == .timedOut {
      do { try job.check() } catch { task.cancel(); done.wait(); throw error }
    }
    try job.check()
    if let failure = failure { throw GuideFailure(failure) }
    if let redirect = redirect { return redirect }
    if status == 401 || status == 403 { throw GuideFailure("login") }
    guard (200...299).contains(status) else { throw GuideFailure("http") }
    try handle?.synchronize(); try handle?.close(); handle = nil
    // Caller moves the complete spool before this object's defer removes its old name.
    try FileManager.default.moveItem(at: file, to: file.appendingPathExtension("closed"))
    return nil
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    // Location stays private. The hop closes; JS alone decides the next address.
    let location = response.value(forHTTPHeaderField: "Location")
    if let location = location, location.utf8.count <= 8192 { redirect = location }
    else { failure = "redirect" }
    status = response.statusCode
    completionHandler(nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if redirect != nil || !(200...299).contains(status) { completionHandler(.cancel); return }
    if response.expectedContentLength > GuideBudget.body { failure = "body"; completionHandler(.cancel); return }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do {
      try job.check()
      count += Int64(data.count)
      if count > GuideBudget.body { throw GuideFailure("body") }
      // No async work queue that retains callback Data without backpressure.
      for offset in stride(from: 0, to: data.count, by: 65536) {
        guard let handle = handle else { throw GuideFailure("disk") }
        try disk.write(data.subdata(in: offset..<min(data.count, offset + 65536)), to: file, handle: handle)
      }
      try disk.check()
    } catch let error as GuideFailure { failure = error.code; dataTask.cancel() }
    catch { failure = "disk"; dataTask.cancel() }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if error != nil && failure == nil && redirect == nil && (200...299).contains(status) { failure = "network" }
    if error != nil && status == 0 { failure = "network" }
    done.signal()
  }
}
