import Foundation

/** Why a command was refused, as JavaScript reads it: a fixed code and fixed words. */
enum Refusal: String, Error {
  /// A name, address or file type of a form the owner doesn't take.
  case invalid = "ERR_DOWNLOADS_INVALID"
  /// Another attempt's request may still be open.
  case busy = "ERR_DOWNLOADS_BUSY"
  /// The ledger can't be read or written now, as before the first unlock.
  case unavailable = "ERR_DOWNLOADS_UNAVAILABLE"
  /// The ledger is there but isn't one: nothing it names can be trusted.
  case corrupt = "ERR_DOWNLOADS_CORRUPT"
  /// The Keychain wouldn't answer.
  case keychain = "ERR_DOWNLOADS_KEYCHAIN"
  /// The download's folder isn't there.
  case folder = "ERR_DOWNLOADS_FOLDER"

  var words: String {
    switch self {
    case .invalid: return "The download request isn't one this app makes."
    case .busy: return "Another download's request is still open."
    case .unavailable: return "The downloads can't be read until the iPhone is unlocked."
    case .corrupt: return "The downloads' record is damaged."
    case .keychain: return "The Keychain didn't answer."
    case .folder: return "The download's folder is gone."
    }
  }
}

/**
 The one owner of the app's background URLSession and of what its requests leave: the ledger of
 authorized attempts and of their endings (`Ledger.swift`), the files they move into place and the
 resume data they leave (`ResumeSecrets.swift`). Commands from JavaScript and URLSession's
 callbacks run on one serial queue, so each sees the ledger as the last one left it.

 JavaScript decides what transfers, and is the only one to call a download complete; this side
 only finishes an attempt JavaScript authorized. A transfer goes on while the app is suspended,
 and after iOS ends the app's process: the session is made again at launch, before JavaScript
 runs, so its callbacks find their attempt in the ledger. Every ending is written down as a
 receipt, with any resume data in the Keychain first, before JavaScript hears of it; a receipt
 stays until JavaScript acknowledges it, so one heard by nobody is found again by `reconcile`.
 */
final class TransferOwner: NSObject, URLSessionDownloadDelegate {
  static let shared = TransferOwner()
  static let identifier = "\(Bundle.main.bundleIdentifier ?? "app.mrstreamer.player").downloads"
  /// How often progress reaches JavaScript, at most.
  private static let progressInterval: TimeInterval = 0.25

  private let queue = DispatchQueue(label: "app.mrstreamer.downloads")
  private let file = LedgerFile()
  private let secrets = ResumeSecrets()

  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
  }()

  /// Nil until read; then the authority, kept in memory when a write fails.
  private var ledger: Ledger?
  private var corrupt = false
  /// The task of each attempt this process knows.
  private var tasks: [String: URLSessionDownloadTask] = [:]
  /// What a finished task's file came to, until its request's end is heard.
  private var finished: [String: Outcome] = [:]
  private var pauses: [String: Pause] = [:]
  /// Callers waiting for a task's request to end, by task identifier.
  private var waiters: [Int: [() -> Void]] = [:]
  /// Tasks whose request ended in this process.
  private var ended: Set<Int> = []
  private var progress: [String: Seen] = [:]
  private var completions: [() -> Void] = []
  private var eventsFinished = false
  private var listener: ((String, [String: Any]) -> Void)?

  private struct Pause {
    var answered = false
    var data: Data?
    var closed = false
  }

  private struct Seen {
    var received: Int64
    var expected: Int64?
    var sentAt: TimeInterval = 0
    /// Where URLSession said a resumed request went on from, and whether its counts start there.
    var offset: Int64 = 0
    var counted: Bool?
  }

  // MARK: Launch and the system's wake

  /** Makes the session at launch, so the callbacks of tasks from before it find their owner. */
  func connect() {
    queue.async {
      _ = self.load()
      _ = self.session
    }
  }

  /**
   Keeps the handler iOS gives with a wake for this session, and calls it on the main queue once
   every callback it woke the app for has been written down, which needs no JavaScript.
   */
  func hold(_ completion: @escaping () -> Void) {
    queue.async {
      _ = self.load()
      _ = self.session
      if self.eventsFinished {
        self.eventsFinished = false
        DispatchQueue.main.async(execute: completion)
      } else {
        self.completions.append(completion)
      }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard !completions.isEmpty else {
      eventsFinished = true
      return
    }
    let calls = completions
    completions = []
    DispatchQueue.main.async { calls.forEach { $0() } }
  }

  func listen(_ listener: ((String, [String: Any]) -> Void)?) {
    queue.async { self.listener = listener }
  }

  // MARK: Commands

  /**
   Authorizes `attempt` for download `id` and starts its request, going on from the download's
   resume data when it was made for this very `url`. The attempt is written down before its
   request goes out. The same attempt again answers as the first did; any other attempt is
   refused while an earlier one may still have a request open. Answers whether it goes on.
   */
  func start(
    id: String, attempt: String, ext: String, url address: String, headers: [String: String],
    done: @escaping (Result<Bool, Refusal>) -> Void
  ) {
    queue.async {
      guard Names.isId(id), Names.isAttempt(attempt), Names.isExtension(ext),
        let url = URL(string: address), ["http", "https"].contains(url.scheme?.lowercased() ?? "")
      else { return done(.failure(.invalid)) }
      guard let ledger = self.load() else { return done(.failure(self.corrupt ? .corrupt : .unavailable)) }
      if let known = ledger.attempts[attempt] {
        return done(known.id == id ? .success(known.resumed) : .failure(.invalid))
      }
      guard ledger.attempts.isEmpty else { return done(.failure(.busy)) }
      guard Names.folder(id) != nil else { return done(.failure(.folder)) }
      var resumeData: Data?
      switch self.secrets.read(id) {
      case .unavailable:
        return done(.failure(.keychain))
      case .found(let data, let bound):
        if bound == url.absoluteString {
          resumeData = data
        } else if !self.secrets.remove(id) {
          return done(.failure(.keychain))
        }
      case .missing:
        break
      }
      let task: URLSessionDownloadTask
      if let resumeData {
        task = self.session.downloadTask(withResumeData: resumeData)
      } else {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        task = self.session.downloadTask(with: request)
      }
      task.taskDescription = attempt
      self.ledger?.attempts[attempt] = Attempt(
        id: id, ext: ext, task: task.taskIdentifier, resumed: resumeData != nil)
      guard self.save() else {
        self.ledger?.attempts[attempt] = nil
        // Never resumed: no request went out, and its end finds no attempt.
        task.cancel()
        return done(.failure(.unavailable))
      }
      self.tasks[attempt] = task
      task.resume()
      self.ledger?.attempts[attempt]?.started = true
      _ = self.save()
      done(.success(resumeData != nil))
    }
  }

  /**
   Pauses `attempt`, keeping URLSession's resume data in the Keychain. Answers once its request
   has ended, or at once when it has none open; its receipt says whether it can go on.
   */
  func pause(attempt: String, done: @escaping () -> Void) {
    queue.async {
      guard let known = self.ledger?.attempts[attempt], !known.revoked else { return done() }
      guard let task = self.tasks[attempt] else {
        // Known to the ledger but to no task of the session: it has no request open.
        self.close(attempt, .init(kind: .paused, resumable: self.secrets.has(known.id)))
        return done()
      }
      self.whenEnded(task, done)
      guard self.pauses[attempt] == nil else { return }
      self.pauses[attempt] = Pause()
      task.cancel(byProducingResumeData: { data in
        self.queue.async {
          self.pauses[attempt]?.answered = true
          self.pauses[attempt]?.data = data
          self.finishPause(attempt, task)
        }
      })
    }
  }

  /**
   Revokes `attempt`, written down before its request is cancelled so that a file it finishes
   meanwhile is never moved into place, and removes its download's resume data. Answers once the
   request has ended.
   */
  func cancel(attempt: String, done: @escaping () -> Void) {
    queue.async {
      guard let known = self.ledger?.attempts[attempt] else { return done() }
      self.ledger?.attempts[attempt]?.revoked = true
      _ = self.save()
      _ = self.secrets.remove(known.id)
      guard let task = self.tasks[attempt] else {
        self.close(attempt, .cancelled)
        return done()
      }
      self.whenEnded(task, done)
      task.cancel()
    }
  }

  /**
   The attempts whose request may still be open and the receipts not yet acknowledged, as one
   moment of the ledger. Before answering, any task of the session that isn't an authorized
   attempt's, unreadable ones included, is cancelled and its request has ended; `closed` counts
   them, since they leave no receipt, so JavaScript gives their provider its time to free the
   connection. An attempt left by a process that ended mid-way is settled from what is on disk.
   Refused while the ledger can't be read, so nothing new asks the provider meanwhile.
   */
  func reconcile(done: @escaping (Result<[String: Any], Refusal>) -> Void) {
    queue.async {
      guard self.load() != nil else { return done(.failure(self.corrupt ? .corrupt : .unavailable)) }
      self.session.getAllTasks { all in
        self.queue.async { self.reconcile(all, done) }
      }
    }
  }

  /** Forgets receipts JavaScript wrote down. Another receipt, newer or not, stays. */
  func acknowledge(_ receipts: [String], done: @escaping (Result<Void, Refusal>) -> Void) {
    queue.async {
      guard self.load() != nil else { return done(.failure(self.corrupt ? .corrupt : .unavailable)) }
      self.ledger?.receipts.removeAll { receipts.contains($0.receipt) }
      done(self.save() ? .success(()) : .failure(.unavailable))
    }
  }

  /** Removes a download's resume data. */
  func forgetResume(id: String, done: @escaping (Result<Void, Refusal>) -> Void) {
    queue.async {
      guard Names.isId(id) else { return done(.failure(.invalid)) }
      done(self.secrets.remove(id) ? .success(()) : .failure(.keychain))
    }
  }

  /**
   Takes resume data an earlier build kept, for the address it was made for. Resume data already
   here for the download stays: it is the newer.
   */
  func importResume(
    id: String, url address: String, data encoded: String,
    done: @escaping (Result<Void, Refusal>) -> Void
  ) {
    queue.async {
      guard Names.isId(id), let url = URL(string: address), let data = Data(base64Encoded: encoded)
      else { return done(.failure(.invalid)) }
      switch self.secrets.read(id) {
      case .unavailable:
        done(.failure(.keychain))
      case .found:
        done(.success(()))
      case .missing:
        done(self.secrets.write(id, url: url.absoluteString, data: data) ? .success(()) : .failure(.keychain))
      }
    }
  }

  // MARK: URLSession

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64,
    expectedTotalBytes: Int64
  ) {
    guard let attempt = authorized(downloadTask) else { return }
    progress[attempt] = Seen(received: fileOffset, expected: nil, offset: fileOffset)
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard let attempt = authorized(downloadTask) else { return }
    var known = progress[attempt] ?? Seen(received: 0, expected: nil)
    // Whether URLSession counts a resumed request from its offset is decided by its first count.
    if known.counted == nil { known.counted = known.offset == 0 || totalBytesWritten >= known.offset }
    known.received = known.counted == true ? totalBytesWritten : known.offset + totalBytesWritten
    known.expected =
      Self.wholeSize(downloadTask.response)
      ?? (totalBytesExpectedToWrite >= 0 && known.counted == true ? totalBytesExpectedToWrite : nil)
    let now = Date().timeIntervalSince1970
    if now - known.sentAt >= Self.progressInterval {
      known.sentAt = now
      emit("progress", [
        "attempt": attempt, "received": known.received,
        "expected": known.expected.map { $0 as Any } ?? NSNull(),
      ])
    }
    progress[attempt] = known
  }

  /**
   Moves a finished file into place: written down as finishing, with its size, before it moves,
   so that a process ending between the move and the receipt leaves what `reconcile` needs to
   tell a whole file from none. A file of an attempt not authorized, or revoked, is left to
   URLSession, which deletes it.
   */
  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL
  ) {
    guard let attempt = authorized(downloadTask), let known = ledger?.attempts[attempt] else { return }
    if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
      finished[attempt] = Outcome(kind: .refused, status: http.statusCode)
      return
    }
    let size = Names.size(of: location) ?? 0
    let expected = Self.wholeSize(downloadTask.response)
    guard let media = Names.media(known.id, known.ext) else {
      finished[attempt] = .folder
      return
    }
    ledger?.attempts[attempt]?.finishing = Finishing(size: size, expected: expected)
    guard save() else {
      ledger?.attempts[attempt]?.finishing = nil
      finished[attempt] = .network(0, resumable: false)
      return
    }
    do {
      if FileManager.default.fileExists(atPath: media.path) {
        try FileManager.default.removeItem(at: media)
      }
      try FileManager.default.moveItem(at: location, to: media)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: media.path)
      finished[attempt] = Outcome(kind: .complete, size: size, expected: expected)
    } catch {
      try? FileManager.default.removeItem(at: media)
      ledger?.attempts[attempt]?.finishing = nil
      _ = save()
      finished[attempt] = .folder
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let identifier = task.taskIdentifier
    defer {
      ended.insert(identifier)
      waiters.removeValue(forKey: identifier)?.forEach { $0() }
    }
    guard let attempt = task.taskDescription, let known = load()?.attempts[attempt],
      known.task == identifier
    else { return }
    if known.revoked { return close(attempt, .cancelled) }
    guard let error = error as NSError? else {
      return close(attempt, finished[attempt] ?? .network(0, resumable: false))
    }
    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled, pauses[attempt] != nil {
      pauses[attempt]?.closed = true
      return finishPause(attempt, task)
    }
    let data = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    let resumable = data.map { keep($0, of: known.id, for: task) } ?? false
    close(attempt, .network(error.domain == NSURLErrorDomain ? error.code : 0, resumable: resumable))
  }

  // MARK: Ledger

  /** The ledger, read once; a new install first removes resume data an earlier one left. */
  private func load() -> Ledger? {
    if let ledger { return ledger }
    guard !corrupt else { return nil }
    switch file.read() {
    case .none:
      guard secrets.removeAll() else { return nil }
      let fresh = Ledger()
      guard file.write(fresh) else { return nil }
      ledger = fresh
    case .read(let read):
      ledger = read
    case .unavailable:
      return nil
    case .corrupt:
      corrupt = true
      return nil
    }
    return ledger
  }

  private func save() -> Bool {
    guard let ledger else { return false }
    return file.write(ledger)
  }

  /** The attempt a task belongs to, while it is authorized and not revoked. */
  private func authorized(_ task: URLSessionTask) -> String? {
    // Read here too: a wake before the first unlock finds the ledger once it can be read.
    guard let attempt = task.taskDescription, let known = load()?.attempts[attempt],
      known.task == task.taskIdentifier, !known.revoked
    else { return nil }
    return attempt
  }

  private func whenEnded(_ task: URLSessionTask, _ done: @escaping () -> Void) {
    if ended.contains(task.taskIdentifier) { return done() }
    waiters[task.taskIdentifier, default: []].append(done)
  }

  /** Keeps resume data for the address its request was made for; true once it is kept. */
  private func keep(_ data: Data, of id: String, for task: URLSessionTask) -> Bool {
    guard let url = task.originalRequest?.url?.absoluteString else { return false }
    return secrets.write(id, url: url, data: data)
  }

  /** A pause ends once its request ended and URLSession answered with resume data or none. */
  private func finishPause(_ attempt: String, _ task: URLSessionTask) {
    guard let pause = pauses[attempt], pause.answered, pause.closed,
      let known = ledger?.attempts[attempt]
    else { return }
    if known.revoked { return close(attempt, .cancelled) }
    let resumable = pause.data.map { keep($0, of: known.id, for: task) } ?? false
    close(attempt, Outcome(kind: .paused, resumable: resumable))
  }

  /**
   Ends an attempt with its receipt, in one write, then tells JavaScript. Should the write fail,
   the receipt stays in memory, and the attempt on disk is settled again by the next launch.
   */
  private func close(_ attempt: String, _ outcome: Outcome) {
    guard let known = ledger?.attempts.removeValue(forKey: attempt) else { return }
    if outcome.kind == .complete || outcome.kind == .cancelled { _ = secrets.remove(known.id) }
    let receipt = Receipt(
      receipt: "r-\(UUID().uuidString.lowercased())", attempt: attempt, id: known.id, outcome: outcome)
    ledger?.receipts.append(receipt)
    _ = save()
    tasks[attempt] = nil
    finished[attempt] = nil
    pauses[attempt] = nil
    progress[attempt] = nil
    emit("receipt", receipt.dictionary)
  }

  private func reconcile(_ all: [URLSessionTask], _ done: @escaping (Result<[String: Any], Refusal>) -> Void) {
    guard let ledger else { return done(.failure(.unavailable)) }
    var adopted: String?
    var strays: [URLSessionTask] = []
    for task in all where task.state != .completed {
      if adopted == nil, let attempt = authorized(task), let download = task as? URLSessionDownloadTask {
        adopted = attempt
        tasks[attempt] = download
        if download.state == .suspended { download.resume() }
      } else {
        strays.append(task)
      }
    }
    // Attempts no task of the session has: settled from the ledger and the disk. One started
    // whose task may still have callbacks to come is left to them.
    let present = Set(all.map(\.taskIdentifier))
    for (attempt, known) in ledger.attempts
    where attempt != adopted && tasks[attempt] == nil && !present.contains(known.task) {
      if known.revoked {
        close(attempt, .cancelled)
      } else if let finishing = known.finishing {
        let media = Names.media(known.id, known.ext)
        if let media, Names.size(of: media) == finishing.size {
          close(attempt, Outcome(kind: .complete, size: finishing.size, expected: finishing.expected))
        } else {
          if let media { try? FileManager.default.removeItem(at: media) }
          close(attempt, .network(0, resumable: secrets.has(known.id)))
        }
      } else if !known.started {
        close(attempt, .network(0, resumable: secrets.has(known.id)))
      }
    }
    let group = DispatchGroup()
    for stray in strays {
      group.enter()
      whenEnded(stray) { group.leave() }
      stray.cancel()
    }
    group.notify(queue: queue) {
      let attempts = self.ledger?.attempts ?? [:]
      let running = attempts.compactMap { (attempt, known) -> [String: Any]? in
        guard !known.revoked else { return nil }
        let seen = self.progress[attempt]
        return [
          "attempt": attempt, "id": known.id,
          "received": seen.map { $0.received as Any } ?? NSNull(),
          "expected": seen?.expected.map { $0 as Any } ?? NSNull(),
        ]
      }
      let receipts = (self.ledger?.receipts ?? []).map(\.dictionary)
      done(.success(["running": running, "receipts": receipts, "closed": strays.count]))
    }
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    listener?(name, body)
  }

  /** The whole file's size an answer announced: a range's total, or a whole answer's length. */
  private static func wholeSize(_ response: URLResponse?) -> Int64? {
    guard let http = response as? HTTPURLResponse else { return nil }
    if http.statusCode == 206 {
      guard let range = http.value(forHTTPHeaderField: "Content-Range"),
        let total = range.split(separator: "/").last.flatMap({ Int64($0) })
      else { return nil }
      return total
    }
    guard http.statusCode == 200, http.value(forHTTPHeaderField: "Content-Encoding") == nil,
      http.expectedContentLength >= 0
    else { return nil }
    return http.expectedContentLength
  }
}
