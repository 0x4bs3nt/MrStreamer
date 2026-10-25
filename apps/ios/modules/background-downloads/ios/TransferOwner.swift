import CryptoKit
import Foundation

/** Why a command was refused, as JavaScript reads it: a fixed code and fixed words. */
enum Refusal: String, Error {
  /// A name, address or file type of a form the owner doesn't take.
  case invalid = "ERR_DOWNLOADS_INVALID"
  /// Another operation on the same source, transfer or reset hasn't settled.
  case busy = "ERR_DOWNLOADS_BUSY"
  /// The queue can't be read or written now, as before the first unlock.
  case unavailable = "ERR_DOWNLOADS_UNAVAILABLE"
  /// The queue is there but isn't one: nothing it names can be trusted.
  case corrupt = "ERR_DOWNLOADS_CORRUPT"
  /// The Keychain wouldn't answer.
  case keychain = "ERR_DOWNLOADS_KEYCHAIN"
  /// The download's folder isn't there.
  case folder = "ERR_DOWNLOADS_FOLDER"
  /// What the command expected is no longer so: another generation, epoch or authorization state.
  case obsolete = "ERR_DOWNLOADS_OBSOLETE"
  /// The queue holds as many authorizations and unacknowledged receipts as it may.
  case capacity = "ERR_DOWNLOADS_CAPACITY"
  /// A request's end was never heard: nothing new may ask the provider meanwhile.
  case unknownClosure = "ERR_DOWNLOADS_UNKNOWN_CLOSURE"

  var words: String {
    switch self {
    case .invalid: return "The download request isn't one this app makes."
    case .busy: return "Another download operation is still settling."
    case .unavailable: return "The downloads can't be read until the iPhone is unlocked."
    case .corrupt: return "The downloads' record is damaged."
    case .keychain: return "The Keychain didn't answer."
    case .folder: return "The download's folder is gone."
    case .obsolete: return "The download changed meanwhile."
    case .capacity: return "Too many downloads are waiting."
    case .unknownClosure: return "A download's request may still be open."
    }
  }
}

/**
 The one scheduler of the app's background URLSession and owner of what its requests leave: the
 queue of exact file authorizations, its source generations and receipts (`Ledger.swift`), their
 protected request authority (`ResumeSecrets.swift`), and the files they move into place.
 JavaScript (`src/downloads.ts`) owns the download records; it reserves and arms an authorization
 for one exact file after writing it on its record, and takes each receipt in before
 acknowledging it. This side alone chooses what transfers next, while the app is open or not.

 One task may occupy the transfer slot at a time: from the moment the pump claims an
 authorization, before any read or write, through its request, until its local close, file
 publication and terminal commit settle. The next task is made, persisted and resumed with an
 `earliestBeginDate` one second after the last local close of its source, before the system's
 wake handler is answered; the OS owns that wait and may defer it further.

 Commands from JavaScript and URLSession's callbacks run on one serial control queue. The queue
 file and the Keychain are written on one serial I/O lane, one ledger transition at a time, each
 applied to the last committed ledger. Every result that comes back from I/O is checked again
 against the slot, the source generation, memory gates and a fresh read of protected authority
 before a task is resumed or a file is published. A revoke or removal writes its durable fence
 and returns without waiting for task closure; the slot keeps the closing task.

 Playback holds are process memory only: a stream's caller-minted lease pauses that source's
 transfer and waits for its request to end and its grace before the stream may go out.
 */
final class TransferOwner: NSObject, URLSessionDownloadDelegate {
  static let shared = TransferOwner()
  static let identifier = "\(Bundle.main.bundleIdentifier ?? "app.mrstreamer.player").downloads"
  /// How often progress reaches JavaScript, at most.
  private static let progressInterval: TimeInterval = 0.25
  /// A provider's time to free a connection after the app's request of it ended.
  private static let grace: TimeInterval = 1
  /// How long a command awaited inside account changes may take before it is refused.
  private static let commandSeconds: Double = 5
  /// How long a paused request, then a cancelled one, may take to end.
  private static let closeSeconds: Double = 5
  private static let window = 32
  private static let capacity = 128
  private static let requestBytes = 32 * 1024
  private static let urlBytes = 8 * 1024

  private let queue = DispatchQueue(label: "app.mrstreamer.downloads")
  private let io = DispatchQueue(label: "app.mrstreamer.downloads.io")
  private let file = LedgerFile()
  private let vault = Vault()
  /// This process's own name: blocked observations and the fallback epoch are its.
  private let process = Names.mint("q")
  private let launched = Close()

  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
  }()

  // MARK: State

  private enum Storage {
    case unread
    case ready
    case unavailable
    case corrupt(Salvage)
  }
  private var storage: Storage = .unread
  /// The last committed ledger, while `storage` is ready.
  private var ledger: LedgerV2?
  private var lane: [Change] = []
  private var writing = false

  private enum Slot {
    case idle
    case admitting(Admission)
    case bound(Binding)
  }
  private var slot: Slot = .idle
  private var tickets = 0
  /// Tasks no binding owns, cancelled, whose end isn't heard yet: nothing is admitted meanwhile.
  private var unknown: Set<Int> = []
  /// Tasks made and never resumed, then cancelled: their end is no request's.
  private var unused: Set<Int> = []
  private var ended: Set<Int> = []
  private var waiters: [Int: [() -> Void]] = [:]
  /// Asked again whenever the slot settles; each answers whether it is done.
  private var settledWaiters: [() -> Bool] = []

  private var recovered = false
  private var recovering = false
  private var recoveryWork: Work?
  private var legacyEmptied = false

  private enum Barrier {
    case none
    case installed(String)
    case finished(String)
  }
  private var barrier: Barrier = .none
  private var active = false

  private var resetting = false
  private var resetFailed = false
  /// Authorizations removed in this process: never admitted or published again.
  private var removed: Set<String> = []
  /// Sources whose whole service was deleted for want of a ledger write, in this process.
  private var fallbackFenced: Set<String> = []
  /// Sources whose anchor didn't match their enabled ledger generation when last read.
  private var stale: Set<String> = []
  /// Source mutations whose I/O hasn't settled, by source.
  private var sourceTickets: [String: Int] = [:]

  private struct Lease {
    enum State { case acquiring, granted, refused }
    let source: String
    var state: State
    var waiting: [Once<[String: Any]>]
  }
  private var leases: [String: Lease] = [:]
  private var retiredLeases: Set<String> = []
  /// When a request of each source last ended in this process; else launch.
  private var closes: [String: Close] = [:]
  /// When a request no binding owned last ended: every source waits after it.
  private var unknownClose: Close?

  private var listener: ((String, [String: Any]) -> Void)?

  // Delivered-event work and the system's wake handler.
  private struct Work { let generation: Int }
  private var generation = 0
  private var work = 0
  private var expired: Set<Int> = []
  private var handlers: [() -> Void] = []
  private var eventsFinished = false
  private var deadlineArmed: Int?

  /** A request's local close, in wall-clock time for the OS and uptime for in-process waits. */
  private struct Close {
    let date = Date()
    let uptime = ProcessInfo.processInfo.systemUptime
  }

  private final class Admission {
    let ticket: Int
    let authorization: String
    let download: String
    let source: String
    let unit: Work
    var valid = true
    var task: URLSessionDownloadTask?
    var token: String?
    var saving = false
    var saved = false
    /// Its saved attempt still has to be cleared durably: admission stays blocked meanwhile.
    var cleanup = false
    /// Whether the pump may try again at once, as when another authorization won.
    var retry = true
    /// Written as its terminal receipt when its request authority turned out to be gone.
    var fence: OutcomeV2?

    init(ticket: Int, authorization: String, grant: Grant, unit: Work) {
      self.ticket = ticket
      self.authorization = authorization
      download = grant.id
      source = grant.sourceId
      self.unit = unit
    }
  }

  private enum Stop: Equatable {
    case pause
    case diskFull(Int64?)
  }

  private enum Publication {
    case none
    case authority
    case later
  }

  private final class Binding {
    let authorization: String
    let download: String
    let ext: String
    let source: String
    let generation: String
    let token: String
    let task: URLSessionDownloadTask?
    let resumed: Bool
    var restarted: Bool
    var stop: Stop?
    var networkClosed: Bool
    var error: NSError?
    var resumeData: Data?
    var pauseAnswered = true
    /// What the delivered file came to: refused, folder, or complete once published.
    var file: OutcomeV2?
    /// The delivered file in its private stage, until it is published.
    var staged: (url: URL, finishing: Finishing)?
    var publishing = false
    var publication = Publication.none
    var settling = false
    /// Its terminal commit failed: the slot stays closing until a later trigger tries again.
    var blocked = false
    var received: Int64 = 0
    var expected: Int64?
    var sentAt: TimeInterval = 0
    var offset: Int64 = 0
    var counted: Bool?
    var checkedRoom = false

    init(
      _ authorization: String, _ grant: Grant, token: String, task: URLSessionDownloadTask?,
      resumed: Bool, networkClosed: Bool = false
    ) {
      self.authorization = authorization
      download = grant.id
      ext = grant.ext
      source = grant.sourceId
      generation = grant.sourceGeneration
      self.token = token
      self.task = task
      self.resumed = resumed
      restarted = grant.restarted
      self.networkClosed = networkClosed
    }
  }

  private enum Committed { case saved, refused, failed }

  private struct Change {
    let apply: (inout LedgerV2) -> Bool
    let done: (Committed) -> Void
  }

  /** A reply that settles once, whichever of its answer or its deadline comes first. */
  private final class Once<Value> {
    private var done: ((Result<Value, Refusal>) -> Void)?
    init(_ done: @escaping (Result<Value, Refusal>) -> Void) { self.done = done }
    func callAsFunction(_ result: Result<Value, Refusal>) {
      done?(result)
      done = nil
    }
  }

  private func once<Value>(
    _ done: @escaping (Result<Value, Refusal>) -> Void, deadline seconds: Double? = nil
  ) -> Once<Value> {
    let reply = Once(done)
    if let seconds {
      queue.asyncAfter(deadline: .now() + seconds) { reply(.failure(.busy)) }
    }
    return reply
  }

  // MARK: Launch, lifecycle and the system's wake

  /**
   Reads the queue and makes the session at launch, before JavaScript, so the callbacks of tasks
   from before it find their owner, then accounts for every task the session has. The launch's
   recovery is delivered-event work until that ends in a handoff, no work or a refusal.
   */
  func connect() {
    queue.async {
      self.recoveryWork = self.beginWork()
      self.load()
      _ = self.session
      self.recover()
    }
  }

  /**
   Keeps the handler iOS gives with a wake for this session, and calls it on the main queue once
   every delivered event's work settled, the next task handed to the OS included, or five
   seconds after it was given, whatever is still pending then refused.
   */
  func hold(_ completion: @escaping () -> Void) {
    queue.async {
      self.load()
      _ = self.session
      self.handlers.append(completion)
      self.armDeadline()
      self.finishIfSettled()
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    eventsFinished = true
    finishIfSettled()
  }

  /** The app became active: the first time in this process, its foreground barrier goes up. */
  func didBecomeActive() {
    queue.async {
      self.active = true
      self.ensureInstalled()
    }
  }

  func willResignActive() {
    queue.async { self.active = false }
  }

  func listen(_ listener: ((String, [String: Any]) -> Void)?) {
    queue.async { self.listener = listener }
  }

  private func beginWork() -> Work {
    work += 1
    return Work(generation: generation)
  }

  private func endWork(_ unit: Work) {
    guard unit.generation == generation, work > 0 else { return }
    work -= 1
    finishIfSettled()
  }

  /** Whether work begun in this batch may still resume or publish: its deadline hasn't passed. */
  private func live(_ unit: Work) -> Bool { !expired.contains(unit.generation) }

  private func finishIfSettled() {
    guard !handlers.isEmpty, eventsFinished, work == 0 else { return }
    finishHandlers()
  }

  private func finishHandlers() {
    let calls = handlers
    handlers = []
    eventsFinished = false
    generation += 1
    work = 0
    DispatchQueue.main.async { calls.forEach { $0() } }
  }

  private func armDeadline() {
    let held = generation
    guard deadlineArmed != held else { return }
    deadlineArmed = held
    queue.asyncAfter(deadline: .now() + Self.commandSeconds) {
      guard self.generation == held, !self.handlers.isEmpty else { return }
      // Refused, not closed: late work of this batch can't resume or publish, and every gate stays.
      self.expired.insert(held)
      if case .admitting(let admission) = self.slot, admission.unit.generation == held {
        admission.retry = false
        self.abort(admission)
      }
      self.finishHandlers()
    }
  }

  private func ensureInstalled() {
    if case .none = barrier { barrier = .installed(Names.mint("f")) }
  }

  // MARK: Commands: sources

  /**
   How a source's download authority stands, as an observation a later enable or revoke must
   name: enabled under a generation, revoked, missing in this epoch, fenced, or blocked when the
   queue or the Keychain can't be read. Refused after five seconds.
   */
  func sourceState(_ source: String, done: @escaping (Result<[String: Any], Refusal>) -> Void) {
    queue.async {
      let reply: Once<[String: Any]> = self.once(done, deadline: Self.commandSeconds)
      guard Names.isSource(source) else { return reply(.failure(.invalid)) }
      self.load()
      self.io.async {
        let anchor = self.vault.anchor(source)
        self.queue.async { reply(.success(self.observe(source, anchor).dictionary)) }
      }
    }
  }

  /**
   Enables `source` under a fresh generation, when it stands as `expected` in `epoch`: its anchor
   first, then the ledger, ending any authorization of an older generation with a refresh
   receipt. Refused after five seconds; a late write is settled under its ticket and can't
   enable anything another operation changed since.
   */
  func enableSource(
    _ source: String, epoch: String, expected: String,
    done: @escaping (Result<[String: Any], Refusal>) -> Void
  ) {
    queue.async {
      let reply: Once<[String: Any]> = self.once(done, deadline: Self.commandSeconds)
      guard Names.isSource(source) else { return reply(.failure(.invalid)) }
      self.load()
      guard case .ready = self.storage, let ledger = self.ledger else {
        return reply(.failure(self.refusal))
      }
      guard self.sourceTickets[source] == nil, !self.resetting else {
        return reply(.failure(.busy))
      }
      let ticket = self.ticket(source)
      let generation = Names.mint("g")
      let install = ledger.install
      self.io.async {
        let anchor = self.vault.anchor(source)
        self.queue.async {
          let seen = self.observe(source, anchor)
          guard seen.state != "blocked" else {
            self.untick(source, ticket)
            return reply(.failure(.keychain))
          }
          guard epoch == seen.epoch, expected == seen.expected, self.ledger?.install == install else {
            self.untick(source, ticket)
            return reply(.failure(.obsolete))
          }
          if seen.state == "enabled", let current = seen.generation {
            self.untick(source, ticket)
            return reply(.success(["generation": current]))
          }
          self.io.async {
            let anchored = self.vault.setAnchor(
              source, .init(queueEpoch: install, sourceGeneration: generation))
            self.queue.async {
              guard anchored else {
                self.untick(source, ticket)
                return reply(.failure(.keychain))
              }
              var made: [ReceiptV2] = []
              self.commit({ ledger in
                guard ledger.install == install, ledger.sources[source] == seen.authority else {
                  return false
                }
                ledger.sources[source] = SourceAuthority(generation: generation, state: .enabled)
                made = self.endSource(&ledger, source, keeping: generation)
                return true
              }) { result in
                self.untick(source, ticket)
                switch result {
                case .saved:
                  self.fallbackFenced.remove(source)
                  self.stale.remove(source)
                  made.forEach { self.emit("receipt", $0.dictionary) }
                  reply(.success(["generation": generation]))
                  self.pump()
                case .refused: reply(.failure(.obsolete))
                case .failed: reply(.failure(.unavailable))
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   Revokes `source`, when it stands as `expected` in `epoch`: its memory gate at once, then one
   ledger write giving it a fresh revoked generation and ending its unfinished authorizations
   with refresh receipts. Should the ledger refuse the write, the source's whole Keychain service
   goes instead, which fences dispatch and publication as surely. Answers once either fence is
   durable, without waiting for any task to close: cancellation is sent first and the slot keeps
   the closing task. Refused, changing no fence, when neither can be made, and after five
   seconds; a late result is settled under its ticket.
   */
  func revokeSource(
    _ source: String, epoch: String, expected: String,
    done: @escaping (Result<[String: Any], Refusal>) -> Void
  ) {
    queue.async {
      let reply: Once<[String: Any]> = self.once(done, deadline: Self.commandSeconds)
      guard Names.isSource(source) else { return reply(.failure(.invalid)) }
      self.load()
      guard self.sourceTickets[source] == nil, !self.resetting else {
        return reply(.failure(.busy))
      }
      let ticket = self.ticket(source)
      self.giveWay(source)
      self.io.async {
        let anchor = self.vault.anchor(source)
        self.queue.async {
          let seen = self.observe(source, anchor)
          guard epoch == seen.epoch, expected == seen.expected else {
            self.untick(source, ticket)
            self.pump()
            return reply(.failure(.obsolete))
          }
          if seen.state == "revoked" {
            self.untick(source, ticket)
            return reply(.success(self.fenceReply("already-terminal", source: source)))
          }
          let revoked = Names.mint("g")
          var made: [ReceiptV2] = []
          let install = self.ledger?.install
          self.commit({ ledger in
            guard ledger.install == install, ledger.sources[source] == seen.authority else {
              return false
            }
            ledger.sources[source] = SourceAuthority(generation: revoked, state: .revoked)
            made = self.endSource(&ledger, source, keeping: nil)
            return true
          }) { result in
            switch result {
            case .saved:
              made.forEach { self.emit("receipt", $0.dictionary) }
              self.cancelSource(source)
              reply(.success(self.fenceReply("ledger", source: source)))
              // Best effort, on the same lane: only what the revoked generation owned. Its ticket
              // stays until this settles, so a later enable can't race the deletion.
              let old = seen.generation
              self.io.async {
                if let old { _ = self.vault.removeAnchor(source, generation: old) }
                for receipt in made {
                  _ = self.vault.removeRequest(source, receipt.authorization)
                  _ = self.vault.removeResume(source, receipt.id, ownedBy: receipt.authorization)
                }
                self.queue.async {
                  self.untick(source, ticket)
                  self.pump()
                }
              }
            case .refused:
              self.untick(source, ticket)
              reply(.failure(.obsolete))
              self.pump()
            case .failed:
              self.io.async {
                let deleted = self.vault.removeSource(source)
                self.queue.async {
                  self.untick(source, ticket)
                  guard deleted else {
                    self.pump()
                    return reply(.failure(.keychain))
                  }
                  self.fallbackFenced.insert(source)
                  self.cancelSource(source)
                  reply(.success(self.fenceReply("secrets", source: source)))
                }
              }
            }
          }
        }
      }
    }
  }

  private func ticket(_ source: String) -> Int {
    tickets += 1
    sourceTickets[source] = tickets
    return tickets
  }

  private func untick(_ source: String, _ ticket: Int) {
    if sourceTickets[source] == ticket { sourceTickets[source] = nil }
  }

  /** Ends `source`'s unfinished authorizations of any generation but `keeping`, with refresh receipts. */
  private func endSource(_ ledger: inout LedgerV2, _ source: String, keeping: String?)
    -> [ReceiptV2]
  {
    var made: [ReceiptV2] = []
    for (id, var grant) in ledger.authorizations
    where grant.sourceId == source && grant.state != .terminal && grant.sourceGeneration != keeping {
      if grant.state == .reserved {
        ledger.authorizations[id] = nil
        continue
      }
      let attempt = grant.attempt?.token
      grant.attempt = nil
      grant.state = .terminal
      made.append(record(&ledger, &grant, id, .refresh(.source), attempt: attempt))
      ledger.authorizations[id] = grant
    }
    return made
  }

  /** Stops admitting `source`: an admission of it gives way, others may go on when `retry`. */
  private func giveWay(_ source: String, retry: Bool = false) {
    if case .admitting(let admission) = slot, admission.source == source {
      admission.retry = retry
      abort(admission)
    }
  }

  /** Cancels the transfer of `source`, without waiting: the slot keeps it until it ends. */
  private func cancelSource(_ source: String) {
    giveWay(source)
    if case .bound(let binding) = slot, binding.source == source { binding.task?.cancel() }
  }

  private func fenceReply(_ durable: String, source: String? = nil, authorization: String? = nil)
    -> [String: Any]
  {
    let receipts = (ledger?.receipts ?? []).filter {
      authorization == nil || $0.authorization == authorization
    }
    var body: [String: Any] = [
      "durable": durable, "receipts": receipts.map(\.dictionary),
      "legacy": (ledger?.legacy.receipts ?? []).map(\.dictionary),
    ]
    if let source { body["source"] = observe(source, nil).dictionary }
    return body
  }

  private struct Observation {
    let state: String
    let generation: String?
    let expected: String
    let epoch: String
    /// The ledger's entry this observation stands for, which a mutation compares again.
    let authority: SourceAuthority?

    var dictionary: [String: Any] {
      [
        "state": state, "generation": generation.map { $0 as Any } ?? NSNull(),
        "expected": ["queueEpoch": epoch, "expected": expected],
      ]
    }
  }

  private var epoch: String {
    if case .ready = storage, let ledger { return ledger.install }
    return process
  }

  /**
   A source's observation. Enabled needs both the ledger's enabled generation and a matching
   anchor; any other combination is fenced or blocked, named by an opaque token derived from what
   was seen. A nil `anchor` reuses what the ledger says, for replies after a write.
   */
  private func observe(_ source: String, _ anchor: Vault.Read<Vault.Anchor>?) -> Observation {
    let epoch = self.epoch
    guard case .ready = storage, let ledger else {
      let token = opaque(["blocked", process, source, describe(anchor)])
      return Observation(
        state: "blocked", generation: token, expected: token, epoch: epoch, authority: nil)
    }
    let authority = ledger.sources[source]
    if case .some(.unavailable) = anchor {
      let token = opaque(["blocked", process, source, "keychain"])
      return Observation(
        state: "blocked", generation: token, expected: token, epoch: epoch, authority: authority)
    }
    let fenced = opaque([
      "fenced", epoch, authority?.generation ?? "none", describe(anchor),
      fallbackFenced.contains(source) ? process : "",
    ])
    let anchored: Bool = {
      guard let anchor else { return !fallbackFenced.contains(source) }
      if case .found(let found) = anchor {
        return found.queueEpoch == ledger.install
          && found.sourceGeneration == authority?.generation
      }
      return false
    }()
    switch authority {
    case nil:
      let absent: Bool = {
        if case .some(.missing) = anchor { return true }
        return anchor == nil
      }()
      if absent && !fallbackFenced.contains(source) {
        return Observation(
          state: "missing", generation: nil, expected: "missing", epoch: epoch, authority: nil)
      }
      return Observation(
        state: "fenced", generation: fenced, expected: fenced, epoch: epoch, authority: nil)
    case .some(let known) where known.state == .revoked:
      return Observation(
        state: "revoked", generation: known.generation, expected: known.generation, epoch: epoch,
        authority: known)
    case .some(let known):
      if anchored && !fallbackFenced.contains(source) {
        return Observation(
          state: "enabled", generation: known.generation, expected: known.generation,
          epoch: epoch, authority: known)
      }
      return Observation(
        state: "fenced", generation: fenced, expected: fenced, epoch: epoch, authority: known)
    }
  }

  private func describe(_ anchor: Vault.Read<Vault.Anchor>?) -> String {
    switch anchor {
    case nil: return "-"
    case .some(.missing): return "missing"
    case .some(.unavailable): return "unavailable"
    case .some(.found(let found)): return "\(found.queueEpoch)/\(found.sourceGeneration)"
    }
  }

  private func opaque(_ parts: [String]) -> String {
    let digest = SHA256.hash(data: Data(parts.joined(separator: "\u{1f}").utf8))
    return "o-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  // MARK: Commands: authorizations

  /**
   Reserves an authorization for download `id`'s file under `source`'s enabled `generation`,
   before JavaScript writes it on the record. It asks nothing of anyone until `authorize` arms it.
   Refused at 32 unfinished authorizations, or when one more would leave no room for every
   receipt among 128.
   */
  func reserve(
    id: String, ext: String, source: String, generation: String,
    done: @escaping (Result<[String: Any], Refusal>) -> Void
  ) {
    queue.async {
      guard Names.isId(id), Names.isExtension(ext), Names.isSource(source),
        Names.isGeneration(generation)
      else { return done(.failure(.invalid)) }
      self.load()
      guard case .ready = self.storage, self.ledger != nil else {
        return done(.failure(self.refusal))
      }
      guard !self.resetting, !self.resetFailed else { return done(.failure(.busy)) }
      let enabled = SourceAuthority(generation: generation, state: .enabled)
      let authorization = Names.mint("z")
      var full = false
      self.commit({ ledger in
        guard ledger.sources[source] == enabled, !self.gated(source) else { return false }
        let load = ledger.load
        guard load.authorizations < Self.window,
          load.authorizations + load.receipts + 1 <= Self.capacity
        else {
          full = true
          return false
        }
        ledger.authorizations[authorization] = Grant(
          id: id, ext: ext, sourceId: source, sourceGeneration: generation, order: ledger.nextOrder,
          state: .reserved, restarted: false, freshRestartRemaining: 1,
          lastSequence: ledger.sequence, attempt: nil)
        ledger.nextOrder += 1
        return true
      }) { result in
        switch result {
        case .saved: done(.success(["authorization": authorization]))
        case .refused: done(.failure(full ? .capacity : .obsolete))
        case .failed: done(.failure(.unavailable))
        }
      }
    }
  }

  /**
   Arms a reserved authorization with its exact request: written in the source's protected
   service under the matching anchor before the authorization is queued. The same authorization
   armed again answers as before. The address and headers are never logged nor written to disk.
   */
  func authorize(
    _ authorization: String, url address: String, headers: [String: String],
    done: @escaping (Result<Void, Refusal>) -> Void
  ) {
    queue.async {
      guard Names.isAuthorization(authorization), Self.acceptable(address, headers) else {
        return done(.failure(.invalid))
      }
      self.load()
      guard case .ready = self.storage, let ledger = self.ledger else {
        return done(.failure(self.refusal))
      }
      guard let grant = ledger.authorizations[authorization] else {
        return done(.failure(.obsolete))
      }
      switch grant.state {
      case .reserved: break
      case .terminal: return done(.failure(.obsolete))
      case .queued, .active, .paused: return done(.success(()))
      }
      guard Names.folder(grant.id) != nil else { return done(.failure(.folder)) }
      let request = Vault.Request(
        authorization: authorization, sourceGeneration: grant.sourceGeneration, url: address,
        headers: headers)
      guard let encoded = try? JSONEncoder().encode(request), encoded.count <= Self.requestBytes
      else { return done(.failure(.invalid)) }
      let install = ledger.install
      let source = grant.sourceId
      self.io.async {
        let anchor = self.vault.anchor(source)
        var written = false
        if case .found(let found) = anchor, found.queueEpoch == install,
          found.sourceGeneration == grant.sourceGeneration
        {
          written = self.vault.setRequest(source, request)
        }
        self.queue.async {
          if case .unavailable = anchor { return done(.failure(.keychain)) }
          guard written else { return done(.failure(.obsolete)) }
          self.commit({ ledger in
            guard var armed = ledger.authorizations[authorization], armed.state == .reserved,
              ledger.sources[source]
                == SourceAuthority(generation: armed.sourceGeneration, state: .enabled)
            else { return false }
            armed.state = .queued
            ledger.authorizations[authorization] = armed
            return true
          }) { result in
            switch result {
            case .saved:
              done(.success(()))
              self.pump()
            case .refused: done(.failure(.obsolete))
            case .failed: done(.failure(.unavailable))
            }
          }
        }
      }
    }
  }

  private static func acceptable(_ address: String, _ headers: [String: String]) -> Bool {
    guard address.utf8.count <= urlBytes, let url = URL(string: address),
      ["http", "https"].contains(url.scheme?.lowercased() ?? ""), headers.count <= 32
    else { return false }
    let controls: Set<String> = ["host", "connection", "content-length"]
    let bad = CharacterSet(charactersIn: "\r\n\u{0}")
    return headers.allSatisfy { name, value in
      !name.isEmpty && !controls.contains(name.lowercased())
        && name.rangeOfCharacter(from: bad) == nil && value.rangeOfCharacter(from: bad) == nil
    }
  }

  /**
   Removes an authorization for good, or, with `abandon`, retires a reservation never armed with
   no receipt. A removal installs its memory gate, then writes the authorization terminal with a
   cancelled receipt; should the ledger refuse, its exact request item and owned resume data go
   instead. Answers once either is durable, with the receipts committed for it so far, a complete
   one before the removal included. Cancellation is sent; closure is not awaited.
   */
  func cancelAuthorization(
    _ authorization: String, reason: String, done: @escaping (Result<[String: Any], Refusal>) -> Void
  ) {
    queue.async {
      let reply: Once<[String: Any]> = self.once(done, deadline: Self.commandSeconds)
      guard Names.isAuthorization(authorization), reason == "remove" || reason == "abandon" else {
        return reply(.failure(.invalid))
      }
      self.load()
      guard case .ready = self.storage, let ledger = self.ledger else {
        return reply(.failure(self.refusal))
      }
      guard let grant = ledger.authorizations[authorization] else {
        // Unknown or acknowledged: nothing can arm it again.
        return reply(.success(["durable": "already-terminal", "receipts": [Any](), "legacy": [Any]()]))
      }
      if reason == "abandon" {
        guard grant.state == .reserved else { return reply(.failure(.invalid)) }
        return self.commit({ ledger in
          guard ledger.authorizations[authorization]?.state == .reserved else { return false }
          ledger.authorizations[authorization] = nil
          return true
        }) { result in
          if result == .failed { return reply(.failure(.unavailable)) }
          reply(.success(["durable": "ledger"]))
        }
      }
      if grant.state == .terminal {
        return reply(.success(self.fenceReply("already-terminal", authorization: authorization)))
      }
      self.removed.insert(authorization)
      if case .admitting(let admission) = self.slot, admission.authorization == authorization {
        self.abort(admission)
      }
      var made: ReceiptV2?
      self.commit({ ledger in
        guard var removing = ledger.authorizations[authorization], removing.state != .terminal
        else { return false }
        let attempt = removing.attempt?.token
        removing.attempt = nil
        removing.state = .terminal
        made = self.record(&ledger, &removing, authorization, .cancelled, attempt: attempt)
        ledger.authorizations[authorization] = removing
        return true
      }) { result in
        switch result {
        case .saved:
          if let made { self.emit("receipt", made.dictionary) }
          self.cancelTask(of: authorization)
          reply(.success(self.fenceReply("ledger", authorization: authorization)))
          self.io.async {
            _ = self.vault.removeRequest(grant.sourceId, authorization)
            _ = self.vault.removeResume(grant.sourceId, grant.id, ownedBy: authorization)
          }
        case .refused:
          reply(.success(self.fenceReply("already-terminal", authorization: authorization)))
        case .failed:
          self.io.async {
            let deleted =
              self.vault.removeRequest(grant.sourceId, authorization)
              && self.vault.removeResume(grant.sourceId, grant.id, ownedBy: authorization)
            self.queue.async {
              guard deleted else { return reply(.failure(.keychain)) }
              self.cancelTask(of: authorization)
              reply(.success(["durable": "secrets", "receipts": [Any](), "legacy": [Any]()]))
            }
          }
        }
      }
    }
  }

  private func cancelTask(of authorization: String) {
    if case .bound(let binding) = slot, binding.authorization == authorization {
      binding.task?.cancel()
    }
  }

  /**
   Answers once no task or file publication of download `id` occupies the slot, or refuses after
   ten seconds, so the caller defers deleting its folder.
   */
  func drain(download id: String, done: @escaping (Result<Void, Refusal>) -> Void) {
    queue.async {
      let reply: Once<Void> = self.once(done, deadline: Self.closeSeconds * 2)
      let free = { !self.occupies(id) }
      if free() { return reply(.success(())) }
      self.settledWaiters.append {
        guard free() else { return false }
        reply(.success(()))
        return true
      }
    }
  }

  private func occupies(_ download: String) -> Bool {
    switch slot {
    case .idle: return false
    case .admitting(let admission): return admission.download == download
    case .bound(let binding): return binding.download == download
    }
  }

  // MARK: Commands: playback

  /**
   Holds `source`'s provider connection for stream `lease`, a caller-minted process name: no new
   transfer of it is admitted, its transfer pauses, then is cancelled after five seconds, and
   every task no binding owns is cancelled. Answers once each has actually ended and the
   provider's second of grace passed, or refuses after ten seconds, the hold kept until released.
   The same lease again joins; one released, or of another source, is refused. Process memory
   only: no file or Keychain write, so damaged download storage alone can't hold a stream back.
   */
  func acquirePlayback(
    source: String, lease: String, done: @escaping (Result<[String: Any], Refusal>) -> Void
  ) {
    queue.async {
      guard Names.isSource(source), Names.isLease(lease) else { return done(.failure(.invalid)) }
      guard !self.retiredLeases.contains(lease) else { return done(.failure(.obsolete)) }
      let reply = Once(done)
      if var known = self.leases[lease] {
        guard known.source == source else { return reply(.failure(.invalid)) }
        switch known.state {
        case .granted: return reply(.success(self.grant(lease)))
        case .acquiring:
          known.waiting.append(reply)
          self.leases[lease] = known
          return
        case .refused:
          known.state = .acquiring
          known.waiting.append(reply)
          self.leases[lease] = known
        }
      } else {
        self.leases[lease] = Lease(source: source, state: .acquiring, waiting: [reply])
      }
      self.giveWay(source, retry: true)
      self.session.getAllTasks { tasks in
        self.queue.async { self.drain(for: lease, tasks) }
      }
    }
  }

  /**
   Releases stream `lease`, once its readers closed: its source's next transfer waits its grace
   from now. Releasing it again, or before its acquisition answered, changes nothing more; a late
   acquisition of it is refused. Other holds stay.
   */
  func releasePlayback(_ lease: String, done: @escaping () -> Void) {
    queue.async {
      self.retiredLeases.insert(lease)
      if let held = self.leases.removeValue(forKey: lease) {
        held.waiting.forEach { $0(.failure(.obsolete)) }
        if held.state == .granted { self.closes[held.source] = Close() }
      }
      self.pump()
      done()
    }
  }

  private func held(_ source: String) -> Bool { leases.values.contains { $0.source == source } }

  private func grant(_ lease: String) -> [String: Any] {
    [
      "lease": lease, "localDownloadRequestsClosed": true, "gracePolicySatisfied": true,
      "providerDisconnect": "unobservable",
    ]
  }

  private func drain(for lease: String, _ tasks: [URLSessionTask]) {
    guard let held = leases[lease], held.state == .acquiring else { return }
    let source = held.source
    var open: [URLSessionTask] = []
    for task in tasks where task.state != .completed && !ended.contains(task.taskIdentifier) {
      if case .bound(let binding) = slot, binding.task?.taskIdentifier == task.taskIdentifier {
        // Another source's transfer goes on.
        guard binding.source == source else { continue }
        pause(binding)
      } else if case .admitting(let admission) = slot,
        admission.task?.taskIdentifier == task.taskIdentifier
      {
        // Never resumed: it has no request.
        continue
      } else if !unused.contains(task.taskIdentifier) {
        if task.state != .canceling { task.cancel() }
        unknown.insert(task.taskIdentifier)
      } else {
        continue
      }
      open.append(task)
    }
    whenEnded(open, within: Self.closeSeconds) { closed in
      if closed { return self.afterGrace(lease) }
      if case .bound(let binding) = self.slot, binding.source == source, !binding.networkClosed {
        // The pause didn't end it: cancelled now, still a pause for its authorization.
        binding.pauseAnswered = true
        binding.task?.cancel()
      }
      self.whenEnded(open, within: Self.closeSeconds) { closed in
        if closed { return self.afterGrace(lease) }
        guard var refused = self.leases[lease], refused.state == .acquiring else { return }
        let waiting = refused.waiting
        refused.state = .refused
        refused.waiting = []
        self.leases[lease] = refused
        waiting.forEach { $0(.failure(.unknownClosure)) }
      }
    }
  }

  private func afterGrace(_ lease: String) {
    guard let source = leases[lease]?.source else { return }
    queue.asyncAfter(deadline: .now() + remainingGrace(source)) {
      guard var granted = self.leases[lease], granted.state == .acquiring,
        !self.retiredLeases.contains(lease)
      else { return }
      let waiting = granted.waiting
      granted.state = .granted
      granted.waiting = []
      self.leases[lease] = granted
      waiting.forEach { $0(.success(self.grant(lease))) }
    }
  }

  /** Seconds until `source`'s next request may go out: its grace after its last local close. */
  private func remainingGrace(_ source: String) -> TimeInterval {
    let last = max(
      (closes[source] ?? launched).uptime, unknownClose?.uptime ?? -.infinity)
    return max(0, last + Self.grace - ProcessInfo.processInfo.systemUptime)
  }

  private func whenEnded(
    _ tasks: [URLSessionTask], within seconds: Double, _ done: @escaping (Bool) -> Void
  ) {
    var left = Set(tasks.map(\.taskIdentifier).filter { !ended.contains($0) })
    guard !left.isEmpty else { return done(true) }
    var answered = false
    for id in left {
      waiters[id, default: []].append {
        left.remove(id)
        guard left.isEmpty, !answered else { return }
        answered = true
        done(true)
      }
    }
    queue.asyncAfter(deadline: .now() + seconds) {
      guard !answered else { return }
      answered = true
      done(false)
    }
  }

  // MARK: Commands: reconcile, barrier, receipts, reset

  /**
   The queue at one moment: authorizations, receipts not acknowledged and build 14's, the
   foreground barrier's token, and what blocks it. The first foreground reconcile of a process
   installs that barrier before answering. Waits up to five seconds for the launch's recovery.
   */
  func reconcile(context: String, done: @escaping (Result<[String: Any], Refusal>) -> Void) {
    queue.async {
      if context == "first-foreground" { self.ensureInstalled() }
      self.load()
      if !self.recovered { self.recover() }
      self.retryBlocked()
      let reply: Once<[String: Any]> = Once(done)
      let readable: Bool = {
        if case .unavailable = self.storage { return false }
        return true
      }()
      if self.recovered || !readable { return reply(.success(self.snapshot())) }
      self.queue.asyncAfter(deadline: .now() + Self.commandSeconds) {
        reply(.success(self.snapshot()))
      }
      self.settledWaiters.append {
        guard self.recovered else { return false }
        reply(.success(self.snapshot()))
        return true
      }
    }
  }

  /**
   Ends this process's first foreground barrier once JavaScript reconciled under it: new
   transfers may be admitted. The same finished token again succeeds; any other is refused.
   */
  func finishForegroundReconcile(_ token: String, done: @escaping (Result<Void, Refusal>) -> Void) {
    queue.async {
      switch self.barrier {
      case .installed(let installed) where installed == token:
        self.barrier = .finished(token)
        done(.success(()))
        self.pump()
      case .finished(let finished) where finished == token: done(.success(()))
      default: done(.failure(.obsolete))
      }
    }
  }

  /** Forgets receipts JavaScript wrote down, and authorizations nothing more is owed for. */
  func acknowledge(_ receipts: [String], done: @escaping (Result<Void, Refusal>) -> Void) {
    queue.async {
      self.load()
      guard case .ready = self.storage else { return done(.failure(self.refusal)) }
      let gone = Set(receipts)
      self.commit({ ledger in
        let before = (ledger.receipts.count, ledger.legacy.receipts.count, ledger.authorizations.count)
        ledger.receipts.removeAll { gone.contains($0.receipt) }
        ledger.legacy.receipts.removeAll { gone.contains($0.receipt) }
        let owed = Set(ledger.receipts.map(\.authorization))
        for (id, grant) in ledger.authorizations
        where grant.state == .terminal && !owed.contains(id) && !self.binds(id) {
          ledger.authorizations[id] = nil
        }
        return before
          != (ledger.receipts.count, ledger.legacy.receipts.count, ledger.authorizations.count)
      }) { result in
        if result == .failed { done(.failure(.unavailable)) } else { done(.success(())) }
        self.pump()
      }
    }
  }

  private func binds(_ authorization: String) -> Bool {
    switch slot {
    case .idle: return false
    case .admitting(let admission): return admission.authorization == authorization
    case .bound(let binding): return binding.authorization == authorization
    }
  }

  /**
   Starts the queue over in a fresh epoch, in the foreground and only while its authority is
   damaged: every task cancelled and actually ended first, then one capped copy of the damaged
   queue kept, the Keychain services of `knownSources` and build 14's items deleted, and a fresh
   ledger written with every one of those sources revoked and every receipt that could still be
   read kept. Never touches downloads.json, media or logins. Refused, admission kept blocked,
   when a task doesn't end or a deletion or write fails.
   */
  func resetQueue(
    epoch: String, knownSources: [String], done: @escaping (Result<[String: Any], Refusal>) -> Void
  ) {
    queue.async {
      let reply: Once<[String: Any]> = Once(done)
      guard self.active else { return reply(.failure(.busy)) }
      guard !self.resetting, self.sourceTickets.isEmpty else { return reply(.failure(.busy)) }
      guard epoch == self.epoch else { return reply(.failure(.obsolete)) }
      let sources = Array(Set(knownSources.filter(Names.isSource))).sorted()
      self.resetting = true
      var over = false
      let refuse = { (refusal: Refusal) in
        guard !over else { return }
        over = true
        self.resetting = false
        self.resetFailed = true
        reply(.failure(refusal))
      }
      self.queue.asyncAfter(deadline: .now() + Self.closeSeconds * 3) { refuse(.unknownClosure) }
      if case .admitting(let admission) = self.slot {
        admission.retry = false
        self.abort(admission)
      }
      self.session.getAllTasks { tasks in
        self.queue.async {
          let open = tasks.filter {
            $0.state != .completed && !self.ended.contains($0.taskIdentifier)
          }
          for task in open where task.state != .canceling { task.cancel() }
          for task in open where !self.binds(task) && !self.unused.contains(task.taskIdentifier) {
            self.unknown.insert(task.taskIdentifier)
          }
          self.whenEnded(open, within: Self.closeSeconds * 2) { closed in
            guard closed else { return refuse(.unknownClosure) }
            let settled = { () -> Bool in
              guard !over, case .idle = self.slot, !self.writing else { return false }
              over = true
              self.writeReset(sources, reply)
              return true
            }
            if !settled() { self.settledWaiters.append { over || settled() } }
          }
        }
      }
    }
  }

  private func binds(_ task: URLSessionTask) -> Bool {
    if case .bound(let binding) = slot { return binding.task?.taskIdentifier == task.taskIdentifier }
    return false
  }

  private func writeReset(_ sources: [String], _ reply: Once<[String: Any]>) {
    var fresh = LedgerV2.fresh()
    var raw: Data?
    var unreadable = false
    switch storage {
    case .ready:
      fresh.receipts = ledger?.receipts ?? []
      fresh.legacy.receipts = ledger?.legacy.receipts ?? []
    case .corrupt(let salvage):
      fresh.receipts = salvage.receipts
      fresh.legacy.receipts = salvage.legacy
      raw = salvage.raw
      unreadable = salvage.unreadable
    case .unread, .unavailable:
      resetting = false
      resetFailed = true
      return reply(.failure(.unavailable))
    }
    for source in sources {
      fresh.sources[source] = SourceAuthority(generation: Names.mint("g"), state: .revoked)
    }
    fresh.sequence = fresh.receipts.map(\.sequence).max() ?? 0
    let file = self.file
    let vault = self.vault
    io.async {
      let kept = file.keepDiagnostic(raw)
      let cleared = sources.allSatisfy(vault.removeSource) && vault.removeAllLegacy()
      let written = kept && cleared && file.write(fresh)
      self.queue.async {
        self.resetting = false
        guard written else {
          self.resetFailed = true
          return reply(.failure(cleared ? .unavailable : .keychain))
        }
        self.storage = .ready
        self.ledger = fresh
        self.resetFailed = false
        self.removed = []
        self.fallbackFenced = []
        self.stale = []
        self.recovered = true
        reply(
          .success([
            "kind": "reset", "queueEpoch": fresh.install,
            "preservedReceipts": fresh.receipts.map(\.dictionary),
            "legacy": fresh.legacy.receipts.map(\.dictionary), "unreadableFacts": unreadable,
            "legacyCleanup": "complete", "cleanupScope": "known-sources-only",
          ]))
        self.pump()
      }
    }
  }

  /** Removes a download's resume data: build 14's item and each known source's. */
  func forgetResume(id: String, done: @escaping (Result<Void, Refusal>) -> Void) {
    queue.async {
      guard Names.isId(id) else { return done(.failure(.invalid)) }
      self.load()
      let sources = Array((self.ledger?.sources ?? [:]).keys)
      let owned = self.occupies(id)
      self.io.async {
        var gone = self.vault.removeLegacy(id)
        // Resume data the transfer under way may still write stays its own.
        if !owned { for source in sources { gone = self.vault.removeResume(source, id) && gone } }
        done(gone ? .success(()) : .failure(.keychain))
      }
    }
  }

  /**
   Takes resume data an earlier build kept, for the address it was made for, as build 14's item:
   a later authorization of that exact address goes on from it. Newer data already kept stays.
   */
  func importResume(
    id: String, url address: String, data encoded: String,
    done: @escaping (Result<Void, Refusal>) -> Void
  ) {
    queue.async {
      guard Names.isId(id), let url = URL(string: address), let data = Data(base64Encoded: encoded)
      else { return done(.failure(.invalid)) }
      self.io.async {
        switch self.vault.legacy(id) {
        case .unavailable: done(.failure(.keychain))
        case .found: done(.success(()))
        case .missing:
          let written = self.vault.setLegacy(id, .init(url: url.absoluteString, data: data))
          done(written ? .success(()) : .failure(.keychain))
        }
      }
    }
  }

  private var refusal: Refusal {
    if case .corrupt = storage { return .corrupt }
    return .unavailable
  }

  private func snapshot() -> [String: Any] {
    let token: Any = {
      switch barrier {
      case .none: return NSNull()
      case .installed(let token), .finished(let token): return token
      }
    }()
    let bound: Binding? = {
      if case .bound(let binding) = slot { return binding }
      return nil
    }()
    var blocked = "none"
    var receipts: [ReceiptV2] = []
    var legacy: [Receipt] = []
    var sources: [String] = []
    var authorizations: [[String: Any]] = []
    switch storage {
    case .unread, .unavailable: blocked = "locked"
    case .corrupt(let salvage):
      blocked = "corrupt"
      receipts = salvage.receipts
      legacy = salvage.legacy
      sources = salvage.sources
    case .ready:
      if let ledger {
        receipts = ledger.receipts
        legacy = ledger.legacy.receipts
        sources = Array(ledger.sources.keys)
        authorizations = ledger.authorizations.sorted { $0.value.order < $1.value.order }.map {
          entry -> [String: Any] in
          let id = entry.key
          let grant = entry.value
          let mine = bound?.authorization == id ? bound : nil
          return [
            "authorization": id, "id": grant.id, "sourceId": grant.sourceId,
            "sourceGeneration": grant.sourceGeneration, "state": grant.state.rawValue,
            "sequence": grant.lastSequence,
            "attempt": grant.attempt.map { $0.token as Any } ?? NSNull(),
            "received": mine.map { $0.received as Any } ?? NSNull(),
            "expected": mine?.expected.map { $0 as Any } ?? NSNull(),
            "restarted": grant.restarted || mine?.restarted == true,
            "resumed": mine?.resumed ?? false,
          ]
        }
        if !recovered {
          blocked = "recovering"
        } else if resetFailed || bound?.blocked == true {
          blocked = "storage"
        } else if ledger.load.authorizations + ledger.load.receipts >= Self.capacity {
          blocked = "capacity"
        }
      }
    }
    return [
      "version": 2, "queueEpoch": epoch, "sequence": ledger?.sequence ?? 0,
      "foregroundToken": token, "authorizations": authorizations,
      "receipts": receipts.map(\.dictionary), "legacy": ["receipts": legacy.map(\.dictionary)],
      "sources": sources, "blocked": blocked,
    ]
  }

  // MARK: Ledger

  /**
   The queue, read once it can be. With no queue-v2.json, build 14's ledger.json is copied into
   one whole first, its facts kept as build 14's until JavaScript takes them in; a new install
   first removes build 14's resume data an earlier one left. These first writes are the only ones
   made on the control queue, before the session exists.
   */
  private func load() {
    switch storage {
    case .ready, .corrupt: return
    case .unread, .unavailable: break
    }
    switch file.read() {
    case .read(let read):
      ledger = read
      storage = .ready
    case .unavailable: storage = .unavailable
    case .corrupt(let salvage): storage = .corrupt(salvage)
    case .none:
      var fresh = LedgerV2.fresh()
      switch file.readV1() {
      case .unavailable:
        storage = .unavailable
        return
      case .read(let v1): fresh.legacy = LegacyFacts(attempts: v1.attempts, receipts: v1.receipts)
      case .corrupt: break
      case .none:
        guard vault.removeAllLegacy() else {
          storage = .unavailable
          return
        }
      }
      guard file.write(fresh) else {
        storage = .unavailable
        return
      }
      ledger = fresh
      storage = .ready
    }
  }

  /**
   Applies `apply` to the last committed ledger once every transition before it was written, then
   writes the result whole. `apply` answers false when the transition no longer stands.
   */
  private func commit(
    _ apply: @escaping (inout LedgerV2) -> Bool, _ done: @escaping (Committed) -> Void = { _ in }
  ) {
    lane.append(Change(apply: apply, done: done))
    drainLane()
  }

  private func drainLane() {
    while !writing, !lane.isEmpty {
      let change = lane.removeFirst()
      guard case .ready = storage, var candidate = ledger else {
        change.done(.failed)
        continue
      }
      guard change.apply(&candidate) else {
        change.done(.refused)
        continue
      }
      guard candidate.valid else {
        change.done(.failed)
        continue
      }
      writing = true
      let file = self.file
      io.async {
        let saved = file.write(candidate)
        self.queue.async {
          self.writing = false
          if saved { self.ledger = candidate }
          change.done(saved ? .saved : .failed)
          self.drainLane()
        }
      }
    }
  }

  /** Appends `outcome`'s receipt for `grant`, under the ledger's next sequence. */
  private func record(
    _ ledger: inout LedgerV2, _ grant: inout Grant, _ authorization: String, _ outcome: OutcomeV2,
    attempt: String?, received: Int64? = nil, expected: Int64? = nil
  ) -> ReceiptV2 {
    ledger.sequence += 1
    grant.lastSequence = ledger.sequence
    let receipt = ReceiptV2(
      receipt: Names.mint("r"), authorization: authorization, attempt: attempt, id: grant.id,
      sequence: ledger.sequence, received: received, expected: expected,
      restarted: grant.restarted, outcome: outcome)
    ledger.receipts.append(receipt)
    return receipt
  }

  private func emit(_ name: String, _ body: [String: Any]) { listener?(name, body) }

  // MARK: Recovery

  private func recover() {
    guard !recovered, !recovering else { return }
    guard case .ready = storage else {
      if case .corrupt = storage { return reconstructUntrusted() }
      // Unreadable now, as before the first unlock: tasks are left to end; tried again later.
      if let unit = recoveryWork {
        recoveryWork = nil
        endWork(unit)
      }
      return
    }
    recovering = true
    session.getAllTasks { tasks in
      self.queue.async { self.reconstruct(tasks) }
    }
  }

  /** With damaged authority, every task is a stray: cancelled, and admission waits for its end. */
  private func reconstructUntrusted() {
    recovering = true
    session.getAllTasks { tasks in
      self.queue.async {
        self.recovering = false
        for task in tasks where task.state != .completed && !self.ended.contains(task.taskIdentifier) {
          task.cancel()
          self.unknown.insert(task.taskIdentifier)
        }
        self.recovered = true
        self.settleWaiters()
        if let unit = self.recoveryWork {
          self.recoveryWork = nil
          self.endWork(unit)
        }
      }
    }
  }

  /**
   Accounts for every task the session has, against the ledger: the one attempt it names goes on
   in the slot when its task runs, or is cleared and queued again with no receipt when its task
   was never resumed or is gone; a marked finishing file is recovered under fresh authority. Every
   other task is cancelled and waited for, build 14's keeping its resume data for a later exact
   authorization. Build 14's attempts are dropped. Then the pump runs.
   */
  private func reconstruct(_ tasks: [URLSessionTask]) {
    recovering = false
    guard case .ready = storage, let ledger else { return recover() }
    let live = tasks.filter { $0.state != .completed && !ended.contains($0.taskIdentifier) }
    var clear: [String] = []
    let attempt = ledger.authorizations.first { $0.value.attempt != nil && $0.value.state == .active }
    var matched = false
    if case .bound(let binding) = slot, binding.authorization == attempt?.key { matched = true }
    for task in live {
      if case .bound(let binding) = slot, binding.task?.taskIdentifier == task.taskIdentifier {
        continue
      }
      if let id = attempt?.key, let grant = attempt?.value, let made = grant.attempt, !matched,
        task.taskDescription == made.token, task.taskIdentifier == made.task,
        let download = task as? URLSessionDownloadTask
      {
        matched = true
        if task.state == .suspended {
          // Never resumed: no request went out.
          task.cancel()
          unused.insert(task.taskIdentifier)
          clear.append(id)
        } else if case .idle = slot {
          slot = .bound(Binding(id, grant, token: made.token, task: download, resumed: made.resumed))
        } else {
          task.cancel()
          unknown.insert(task.taskIdentifier)
        }
        continue
      }
      if let token = task.taskDescription, let legacy = ledger.legacy.attempts[token],
        legacy.task == task.taskIdentifier, let download = task as? URLSessionDownloadTask
      {
        keepLegacy(download, legacy.id)
      } else {
        task.cancel()
      }
      unknown.insert(task.taskIdentifier)
    }
    var finishing: Binding?
    if let id = attempt?.key, let grant = attempt?.value, let made = grant.attempt, !matched {
      if made.finishing != nil, case .idle = slot {
        let binding = Binding(
          id, grant, token: made.token, task: nil, resumed: made.resumed, networkClosed: true)
        slot = .bound(binding)
        finishing = binding
      } else {
        clear.append(id)
      }
    }
    commit({ ledger in
      var changed = !ledger.legacy.attempts.isEmpty
      ledger.legacy.attempts = [:]
      for id in clear {
        guard var grant = ledger.authorizations[id], grant.attempt != nil else { continue }
        grant.attempt = nil
        if grant.state == .active { grant.state = .queued }
        ledger.authorizations[id] = grant
        changed = true
      }
      return changed
    }) { result in
      guard result != .failed else {
        // Tried again at the next reconcile; nothing is admitted meanwhile.
        if let unit = self.recoveryWork {
          self.recoveryWork = nil
          self.endWork(unit)
        }
        return
      }
      self.recovered = true
      if let finishing { self.settle(finishing) }
      self.pump()
      self.settleWaiters()
      self.emptyLegacy()
      if let unit = self.recoveryWork {
        self.recoveryWork = nil
        self.endWork(unit)
      }
    }
  }

  /** Cancels a build-14 task, keeping its resume data as build 14's item for its address. */
  private func keepLegacy(_ task: URLSessionDownloadTask, _ download: String) {
    let address = task.originalRequest?.url?.absoluteString
    task.cancel(byProducingResumeData: { data in
      guard let data, let address else { return }
      self.io.async { _ = self.vault.setLegacy(download, .init(url: address, data: data)) }
    })
  }

  /** Once build 14's facts are copied and its tasks ended, its ledger.json is left empty. */
  private func emptyLegacy() {
    guard !legacyEmptied, recovered, unknown.isEmpty, ledger?.legacy.attempts.isEmpty == true else {
      return
    }
    legacyEmptied = true
    let file = self.file
    io.async { _ = file.emptyV1() }
  }

  /** Tries again what a failed write left blocked. */
  private func retryBlocked() {
    switch slot {
    case .admitting(let admission) where admission.cleanup: clearAdmission(admission)
    case .bound(let binding) where binding.blocked || binding.publication == .later:
      binding.blocked = false
      binding.settling = false
      guard binding.publication == .later else { return settle(binding) }
      binding.publication = .none
      if let staged = binding.staged, !binding.publishing {
        // A batch refused before it was published: published now from its stage.
        binding.publishing = true
        publish(binding, stage: staged.url, finishing: staged.finishing, unit: beginWork())
      } else {
        settle(binding)
      }
    default: break
    }
  }

  private func settleWaiters() {
    settledWaiters = settledWaiters.filter { !$0() }
  }

  // MARK: The pump

  /**
   Admits the oldest runnable authorization whose source is enabled under its generation, not
   held by playback, revoked or mutating, while the slot is free, nothing unknown is still
   closing, recovery and any first-foreground barrier are done, and the queue has room. The slot
   is claimed before any read: every trigger enters here and finds it taken.
   */
  private func pump() {
    if case .admitting(let admission) = slot, admission.cleanup { return clearAdmission(admission) }
    guard case .idle = slot, recovered, unknown.isEmpty, !resetting, !resetFailed,
      case .ready = storage, let ledger
    else { return }
    if case .installed = barrier { return }
    let load = ledger.load
    guard load.authorizations + load.receipts < Self.capacity else { return }
    guard
      let next = ledger.authorizations
        .filter({ entry in
          let grant = entry.value
          return (grant.state == .queued || grant.state == .paused) && grant.attempt == nil
            && ledger.sources[grant.sourceId]
              == SourceAuthority(generation: grant.sourceGeneration, state: .enabled)
            && !removed.contains(entry.key) && !gated(grant.sourceId) && !held(grant.sourceId)
        })
        .min(by: { $0.value.order < $1.value.order })
    else { return }
    let id = next.key
    let grant = next.value
    tickets += 1
    let admission = Admission(ticket: tickets, authorization: id, grant: grant, unit: beginWork())
    slot = .admitting(admission)
    io.async {
      let found = self.authority(grant, id, resume: true)
      self.queue.async { self.admit(admission, found) }
    }
  }

  /** A source whose authority is changing or fenced in memory. */
  private func gated(_ source: String) -> Bool {
    sourceTickets[source] != nil || fallbackFenced.contains(source) || stale.contains(source)
  }

  private func owns(_ admission: Admission) -> Bool {
    if case .admitting(let current) = slot { return current === admission }
    return false
  }

  private func owns(_ binding: Binding) -> Bool {
    if case .bound(let current) = slot { return current === binding }
    return false
  }

  private struct Authority {
    let anchor: Vault.Read<Vault.Anchor>
    let request: Vault.Read<Vault.Request>
    var resume: Vault.Read<Vault.Resume>?
    var legacy: Vault.Read<Vault.LegacyResume>?
  }

  /** A fresh read of `grant`'s anchor and request item, and its download's resume data. On I/O. */
  private func authority(_ grant: Grant, _ authorization: String, resume: Bool) -> Authority {
    var found = Authority(
      anchor: vault.anchor(grant.sourceId), request: vault.request(grant.sourceId, authorization))
    if resume {
      found.resume = vault.resume(grant.sourceId, grant.id)
      if case .some(.missing) = found.resume { found.legacy = vault.legacy(grant.id) }
    }
    return found
  }

  private enum Verdict {
    case valid(Vault.Request)
    case unavailable
    case sourceFenced
    case requestMissing
    case gone
  }

  /**
   Whether authority read just now still stands for `authorization` on the control queue: the
   ledger's enabled generation, the anchor of this epoch and generation, its exact request item,
   and no memory gate. Cached request payloads are never authority.
   */
  private func judge(_ authorization: String, _ found: Authority) -> Verdict {
    guard case .ready = storage, let ledger, let grant = ledger.authorizations[authorization],
      grant.state != .terminal, !removed.contains(authorization), !resetting
    else { return .gone }
    guard sourceTickets[grant.sourceId] == nil, !fallbackFenced.contains(grant.sourceId),
      ledger.sources[grant.sourceId]
        == SourceAuthority(generation: grant.sourceGeneration, state: .enabled)
    else { return .gone }
    switch found.anchor {
    case .unavailable: return .unavailable
    case .missing: return .sourceFenced
    case .found(let anchor):
      guard anchor.queueEpoch == ledger.install, anchor.sourceGeneration == grant.sourceGeneration
      else { return .sourceFenced }
    }
    switch found.request {
    case .unavailable: return .unavailable
    case .missing: return .requestMissing
    case .found(let request):
      guard request.authorization == authorization,
        request.sourceGeneration == grant.sourceGeneration
      else { return .requestMissing }
      return .valid(request)
    }
  }

  private func refuse(_ admission: Admission, _ verdict: Verdict) {
    switch verdict {
    case .unavailable: admission.retry = false
    case .sourceFenced:
      // Effectively revoked: its source waits for a fresh enable, which ends these authorizations.
      stale.insert(admission.source)
    case .requestMissing: admission.fence = .refresh(.secretMissing)
    case .gone, .valid: break
    }
    abort(admission)
  }

  private func admit(_ admission: Admission, _ found: Authority) {
    guard owns(admission) else { return }
    guard admission.valid, live(admission.unit) else { return abort(admission) }
    let verdict = judge(admission.authorization, found)
    guard case .valid(let request) = verdict, let url = URL(string: request.url),
      let grant = ledger?.authorizations[admission.authorization]
    else { return refuse(admission, verdict) }
    var resumeData: Data?
    if case .some(.found(let kept)) = found.resume, kept.sourceGeneration == grant.sourceGeneration,
      kept.url == request.url, kept.headers == request.headers
    {
      resumeData = kept.data
    } else if case .some(.found(let kept)) = found.legacy, kept.url == request.url {
      resumeData = kept.data
    }
    let task: URLSessionDownloadTask
    if let resumeData {
      task = session.downloadTask(withResumeData: resumeData)
    } else {
      var made = URLRequest(url: url)
      made.cachePolicy = .reloadIgnoringLocalCacheData
      made.httpShouldHandleCookies = false
      for (name, value) in request.headers { made.setValue(value, forHTTPHeaderField: name) }
      task = session.downloadTask(with: made)
    }
    let token = Names.mint("a")
    let begin = Date().addingTimeInterval(remainingGrace(grant.sourceId))
    task.taskDescription = token
    task.earliestBeginDate = begin
    admission.task = task
    admission.token = token
    admission.saving = true
    let id = admission.authorization
    let resumed = resumeData != nil
    commit({ ledger in
      guard var armed = ledger.authorizations[id], armed.state == .queued || armed.state == .paused,
        armed.attempt == nil, !self.removed.contains(id)
      else { return false }
      armed.state = .active
      armed.attempt = NativeAttempt(
        token: token, task: task.taskIdentifier, started: false, resumed: resumed,
        earliestBeginDate: Int64(begin.timeIntervalSince1970 * 1000), finishing: nil)
      ledger.authorizations[id] = armed
      return true
    }) { result in
      admission.saving = false
      admission.saved = result == .saved
      if result == .failed { admission.retry = false }
      guard result == .saved, self.owns(admission), admission.valid, self.live(admission.unit) else {
        return self.abort(admission)
      }
      // Fresh again after the write: the resume data taken is made this authorization's own.
      self.io.async {
        let again = self.authority(grant, id, resume: false)
        if resumed, case .found = again.request {
          _ = self.vault.setResume(
            grant.sourceId, grant.id,
            .init(
              authorization: id, sourceGeneration: grant.sourceGeneration, url: request.url,
              headers: request.headers, data: resumeData ?? Data()))
          _ = self.vault.removeLegacy(grant.id)
        }
        self.queue.async { self.start(admission, again, grant, resumed: resumed) }
      }
    }
  }

  private func start(_ admission: Admission, _ found: Authority, _ grant: Grant, resumed: Bool) {
    guard owns(admission) else { return }
    guard admission.valid, live(admission.unit) else { return abort(admission) }
    let verdict = judge(admission.authorization, found)
    guard case .valid = verdict, let task = admission.task, let token = admission.token else {
      return refuse(admission, verdict)
    }
    let binding = Binding(admission.authorization, grant, token: token, task: task, resumed: resumed)
    slot = .bound(binding)
    task.resume()
    let id = admission.authorization
    commit({ ledger in
      guard var started = ledger.authorizations[id], started.attempt?.token == token else {
        return false
      }
      started.attempt?.started = true
      ledger.authorizations[id] = started
      return true
    })
    endWork(admission.unit)
  }

  /**
   Ends an admission before its task was resumed: the task is cancelled, which can't end anything
   else, and its attempt, once written, is cleared durably, the authorization queued again unless
   a removal or revoke won. The slot stays this admission's until that write settles.
   */
  private func abort(_ admission: Admission) {
    guard owns(admission) else { return }
    admission.valid = false
    if let task = admission.task, !unused.contains(task.taskIdentifier) {
      unused.insert(task.taskIdentifier)
      task.cancel()
    }
    guard !admission.saving else { return }
    guard admission.saved || admission.fence != nil else { return release(admission) }
    admission.cleanup = true
    clearAdmission(admission)
  }

  private func clearAdmission(_ admission: Admission) {
    let id = admission.authorization
    let token = admission.token
    let fence = admission.fence
    var made: ReceiptV2?
    commit({ ledger in
      guard var grant = ledger.authorizations[id], grant.state != .terminal else { return false }
      let owned = token != nil && grant.attempt?.token == token
      guard owned || (fence != nil && grant.attempt == nil) else { return false }
      grant.attempt = nil
      if let fence {
        grant.state = .terminal
        made = self.record(&ledger, &grant, id, fence, attempt: token)
      } else if grant.state == .active {
        grant.state = .queued
      }
      ledger.authorizations[id] = grant
      return true
    }) { result in
      guard self.owns(admission), result != .failed else { return }
      admission.cleanup = false
      if let made { self.emit("receipt", made.dictionary) }
      self.release(admission)
    }
  }

  private func release(_ admission: Admission) {
    guard owns(admission) else { return }
    slot = .idle
    if admission.retry { pump() }
    settleWaiters()
    endWork(admission.unit)
  }

  // MARK: URLSession

  /** The binding `task` belongs to; during launch recovery, the ledger's attempt it runs for. */
  private func binding(for task: URLSessionTask) -> Binding? {
    if case .bound(let binding) = slot {
      return binding.task?.taskIdentifier == task.taskIdentifier
        && binding.token == task.taskDescription ? binding : nil
    }
    guard case .idle = slot, !recovered, case .ready = storage, let ledger,
      let token = task.taskDescription, let download = task as? URLSessionDownloadTask,
      let found = ledger.authorizations.first(where: {
        $0.value.state == .active && $0.value.attempt?.token == token
          && $0.value.attempt?.task == task.taskIdentifier
      }),
      let made = found.value.attempt
    else { return nil }
    let binding = Binding(found.key, found.value, token: token, task: download, resumed: made.resumed)
    slot = .bound(binding)
    return binding
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64,
    expectedTotalBytes: Int64
  ) {
    guard let binding = binding(for: downloadTask) else { return }
    binding.offset = fileOffset
    binding.received = fileOffset
    // The server sent the whole file again, as a changed one does: it starts from zero.
    if binding.resumed && fileOffset == 0 { binding.restarted = true }
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard let binding = binding(for: downloadTask) else { return }
    // Whether URLSession counts a resumed request from its offset is decided by its first count.
    if binding.counted == nil {
      binding.counted = binding.offset == 0 || totalBytesWritten >= binding.offset
    }
    binding.received =
      binding.counted == true ? totalBytesWritten : binding.offset + totalBytesWritten
    binding.expected =
      Self.wholeSize(downloadTask.response)
      ?? (totalBytesExpectedToWrite >= 0 && binding.counted == true ? totalBytesExpectedToWrite : nil)
    if !binding.checkedRoom, let expected = binding.expected {
      binding.checkedRoom = true
      let needed = expected - binding.received
      if let free = Names.free(), free < needed {
        binding.stop = .diskFull(needed)
        downloadTask.cancel()
      }
    }
    let now = Date().timeIntervalSince1970
    guard now - binding.sentAt >= Self.progressInterval else { return }
    binding.sentAt = now
    emit(
      "progress",
      [
        "version": 2, "authorization": binding.authorization, "attempt": binding.token,
        "id": binding.download, "received": binding.received,
        "expected": binding.expected.map { $0 as Any } ?? NSNull(),
        "restarted": binding.restarted, "resumed": binding.resumed,
      ])
  }

  /**
   Keeps a finished file while URLSession's temporary one is still there: moved into this
   attempt's private stage, which publishes nothing. Its finishing marker is then written and
   authority read again before it moves into Documents/downloads. A file of a removed or revoked
   authorization, or of one with no binding, is left to URLSession, which deletes it.
   */
  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL
  ) {
    guard let binding = binding(for: downloadTask), !removed.contains(binding.authorization),
      ledger?.authorizations[binding.authorization]?.state == .active
    else { return }
    if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
      binding.file = .refused(status: http.statusCode)
      return
    }
    guard let stage = file.stage(binding.token) else {
      binding.file = .folder
      return
    }
    do {
      if FileManager.default.fileExists(atPath: stage.path) {
        try FileManager.default.removeItem(at: stage)
      }
      try FileManager.default.moveItem(at: location, to: stage)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: stage.path)
    } catch {
      try? FileManager.default.removeItem(at: stage)
      binding.file = .folder
      return
    }
    let finishing = Finishing(
      size: Names.size(of: stage) ?? 0, expected: Self.wholeSize(downloadTask.response))
    binding.staged = (stage, finishing)
    binding.publishing = true
    publish(binding, stage: stage, finishing: finishing, unit: beginWork())
  }

  private func publish(_ binding: Binding, stage: URL, finishing: Finishing, unit: Work) {
    guard let grant = ledger?.authorizations[binding.authorization] else {
      return published(binding, unit, nil)
    }
    let id = binding.authorization
    io.async {
      let found = self.authority(grant, id, resume: false)
      self.queue.async {
        guard self.owns(binding), self.live(unit) else {
          binding.publication = .later
          return self.published(binding, unit, nil)
        }
        guard case .valid = self.judge(id, found) else {
          binding.publication = .authority
          return self.published(binding, unit, nil)
        }
        self.commit({ ledger in
          guard var marked = ledger.authorizations[id], marked.state == .active,
            marked.attempt?.token == binding.token
          else { return false }
          marked.attempt?.finishing = finishing
          ledger.authorizations[id] = marked
          return true
        }) { result in
          guard result == .saved, self.owns(binding), self.live(unit) else {
            if result != .refused { binding.publication = .later }
            return self.published(binding, unit, nil)
          }
          self.install(binding, grant, stage: stage, finishing: finishing, unit: unit)
        }
      }
    }
  }

  /** Moves a staged file whose marker is written into place, once authority reads true again. */
  private func install(_ binding: Binding, _ grant: Grant, stage: URL, finishing: Finishing, unit: Work) {
    let id = binding.authorization
    io.async {
      let found = self.authority(grant, id, resume: false)
      self.queue.async {
        guard self.owns(binding), self.live(unit) else {
          binding.publication = .later
          return self.published(binding, unit, nil)
        }
        guard case .valid = self.judge(id, found) else {
          binding.publication = .authority
          return self.published(binding, unit, nil)
        }
        let media = Names.media(binding.download, binding.ext)
        self.io.async {
          var outcome = OutcomeV2.folder
          if let media, !FileManager.default.fileExists(atPath: media.path) {
            do {
              try FileManager.default.moveItem(at: stage, to: media)
              try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: media.path)
              if Names.size(of: media) == finishing.size {
                outcome = .complete(size: finishing.size, expected: finishing.expected)
              }
            } catch {
              outcome = .folder
            }
          } else if let media, Names.size(of: media) == finishing.size,
            !FileManager.default.fileExists(atPath: stage.path)
          {
            // Moved before an earlier process ended: the marker names it.
            outcome = .complete(size: finishing.size, expected: finishing.expected)
          }
          self.queue.async { self.published(binding, unit, outcome) }
        }
      }
    }
  }

  private func published(_ binding: Binding, _ unit: Work, _ outcome: OutcomeV2?) {
    if let outcome { binding.file = outcome }
    binding.publishing = false
    settle(binding)
    endWork(unit)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let identifier = task.taskIdentifier
    ended.insert(identifier)
    defer { waiters.removeValue(forKey: identifier)?.forEach { $0() } }
    if unused.remove(identifier) != nil { return }
    guard let binding = binding(for: task) else {
      // A request no binding owned ended: every source gives the provider its time from now.
      unknownClose = Close()
      unknown.remove(identifier)
      if unknown.isEmpty {
        emptyLegacy()
        pump()
      }
      return
    }
    binding.networkClosed = true
    closes[binding.source] = Close()
    let failure = error as NSError?
    binding.error = failure
    if let data = failure?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
      binding.resumeData = data
    }
    settle(binding)
  }

  // MARK: Settling a transfer

  private func pause(_ binding: Binding) {
    guard binding.stop == nil, let task = binding.task, !binding.networkClosed else { return }
    binding.stop = .pause
    binding.pauseAnswered = false
    task.cancel(byProducingResumeData: { data in
      self.queue.async {
        binding.pauseAnswered = true
        if let data { binding.resumeData = data }
        self.settle(binding)
      }
    })
  }

  /**
   Settles the slot's transfer once its request ended locally and its file publication settled:
   a fresh start when the server refused its resume data and one is left, else one receipt
   written with the authorization's next state. A removal, revoke or reset that won leaves it
   only to be cleared. Its stage goes once nothing of it is pending; then the pump runs.
   */
  private func settle(_ binding: Binding) {
    guard owns(binding), binding.networkClosed, !binding.publishing, !binding.settling else { return }
    let grant = ledger?.authorizations[binding.authorization]
    let won =
      resetting || grant == nil || grant?.state == .terminal
      || grant?.attempt?.token != binding.token
    guard won || binding.pauseAnswered else { return }
    binding.settling = true
    let unit = beginWork()
    guard !won, let grant else { return finish(binding, unit) }
    if binding.file == nil, binding.error == nil, binding.publication == .none,
      grant.attempt?.finishing != nil
    {
      return recoverFinishing(binding, grant, unit)
    }
    if binding.publication == .later {
      binding.settling = false
      return endWork(unit)
    }
    if Self.resumeRefused(binding), grant.freshRestartRemaining == 1 {
      return freshRestart(binding, unit)
    }
    let keep = binding.resumeData
    let source = binding.source
    let download = binding.download
    let id = binding.authorization
    io.async {
      var kept = false
      if let keep, case .found(let request) = self.vault.request(source, id) {
        kept = self.vault.setResume(
          source, download,
          .init(
            authorization: id, sourceGeneration: request.sourceGeneration, url: request.url,
            headers: request.headers, data: keep))
      }
      // A complete file's authority is checked fresh once more before it is committed.
      let found = self.authority(grant, id, resume: false)
      self.queue.async { self.conclude(binding, unit, kept: kept, found) }
    }
  }

  private func conclude(_ binding: Binding, _ unit: Work, kept: Bool, _ found: Authority) {
    guard owns(binding) else { return endWork(unit) }
    var outcome = outcomeOf(binding, kept: kept)
    let complete: Bool = {
      if case .complete = outcome { return true }
      return false
    }()
    if complete, case .valid = judge(binding.authorization, found) {
      // Committed under authority read fresh just now.
    } else if complete {
      // Authority ended before the commit: the file stays uncommitted, for its record to clear.
      outcome = .refresh(.secretMissing)
    }
    let id = binding.authorization
    var made: ReceiptV2?
    commit({ ledger in
      guard var grant = ledger.authorizations[id], grant.state == .active,
        grant.attempt?.token == binding.token
      else { return false }
      grant.attempt = nil
      grant.restarted = grant.restarted || binding.restarted
      if case .paused = outcome { grant.state = .paused } else { grant.state = .terminal }
      made = self.record(
        &ledger, &grant, id, outcome, attempt: binding.token, received: binding.received,
        expected: binding.expected)
      ledger.authorizations[id] = grant
      return true
    }) { result in
      switch result {
      case .saved:
        if let made { self.emit("receipt", made.dictionary) }
        let paused: Bool = {
          if case .paused = outcome { return true }
          return false
        }()
        if !paused {
          // Terminal: its request can never go out again; a copy no longer needs resume data.
          let done = complete && outcome != .refresh(.secretMissing)
          let source = binding.source
          let download = binding.download
          self.io.async {
            _ = self.vault.removeRequest(source, id)
            if done { _ = self.vault.removeResume(source, download, ownedBy: id) }
          }
        }
        self.finish(binding, unit)
      case .refused: self.finish(binding, unit)
      case .failed:
        // The slot stays closing; reconcile tries the write again.
        binding.blocked = true
        binding.settling = false
        self.endWork(unit)
      }
    }
  }

  private func outcomeOf(_ binding: Binding, kept: Bool) -> OutcomeV2 {
    if case .some(.diskFull(let needed)) = binding.stop { return .diskFull(needed: needed) }
    guard let error = binding.error else {
      if let file = binding.file { return file }
      return binding.publication == .authority ? .refresh(.secretMissing) : .network(code: 0, resumable: false)
    }
    if binding.stop == .pause { return .paused(resumable: kept) }
    return .network(code: error.domain == NSURLErrorDomain ? error.code : 0, resumable: kept)
  }

  /**
   Whether the server or URLSession refused to go on from resume data: a range or precondition
   refusal, or resume data whose file couldn't be opened. Which codes iOS gives is unproven on a
   phone.
   */
  private static func resumeRefused(_ binding: Binding) -> Bool {
    guard binding.resumed, binding.stop == nil else { return false }
    if case .some(.refused(let status)) = binding.file { return status == 412 || status == 416 }
    guard let error = binding.error, error.domain == NSURLErrorDomain else { return false }
    return error.code == NSURLErrorCannotOpenFile || error.code == NSURLErrorCannotCreateFile
  }

  /**
   Starts the same authorization once more from nothing: the refused resume data it owns is
   deleted first, then one write marks it restarted, spends its fresh start and queues it, with
   no receipt. A Keychain that won't delete it ends the authorization instead.
   */
  private func freshRestart(_ binding: Binding, _ unit: Work) {
    let id = binding.authorization
    let source = binding.source
    let download = binding.download
    io.async {
      let deleted = self.vault.removeResume(source, download, ownedBy: id)
      self.queue.async {
        guard self.owns(binding) else { return self.endWork(unit) }
        guard deleted else {
          binding.error = nil
          binding.file = .refresh(.resumeUnusable)
          return self.conclude(
            binding, unit, kept: false,
            Authority(anchor: .unavailable, request: .unavailable))
        }
        self.commit({ ledger in
          guard var grant = ledger.authorizations[id], grant.state == .active,
            grant.attempt?.token == binding.token
          else { return false }
          grant.attempt = nil
          grant.restarted = true
          grant.freshRestartRemaining = 0
          grant.state = .queued
          ledger.authorizations[id] = grant
          return true
        }) { result in
          if result == .failed {
            binding.blocked = true
            binding.settling = false
            return self.endWork(unit)
          }
          self.finish(binding, unit)
        }
      }
    }
  }

  /**
   A marked file with no publication heard in this process: its stage, or the media it was moved
   to, at the marked size, under fresh authority, is complete; otherwise uncommitted.
   */
  private func recoverFinishing(_ binding: Binding, _ grant: Grant, _ unit: Work) {
    guard let finishing = grant.attempt?.finishing, let stage = file.stage(binding.token) else {
      binding.publication = .authority
      binding.settling = false
      settle(binding)
      return endWork(unit)
    }
    binding.publishing = true
    binding.settling = false
    endWork(unit)
    let id = binding.authorization
    io.async {
      let staged = Names.size(of: stage) == finishing.size
      let found = self.authority(grant, id, resume: false)
      self.queue.async {
        guard self.owns(binding) else { return }
        guard case .valid = self.judge(id, found) else {
          binding.publishing = false
          binding.publication = .authority
          return self.settle(binding)
        }
        let unit = self.beginWork()
        if staged {
          self.install(binding, grant, stage: stage, finishing: finishing, unit: unit)
        } else {
          let media = Names.media(binding.download, binding.ext)
          let whole = media.flatMap { Names.size(of: $0) } == finishing.size
          let outcome: OutcomeV2 =
            whole ? .complete(size: finishing.size, expected: finishing.expected) : .folder
          self.published(binding, unit, outcome)
        }
      }
    }
  }

  /** Frees the slot of a settled transfer, its drained stage removed, then lets the queue go on. */
  private func finish(_ binding: Binding, _ unit: Work) {
    guard owns(binding) else { return endWork(unit) }
    let token = binding.token
    let file = self.file
    io.async {
      if let stage = file.stage(token), FileManager.default.fileExists(atPath: stage.path) {
        try? FileManager.default.removeItem(at: stage)
      }
    }
    slot = .idle
    pump()
    settleWaiters()
    sweepStages()
    endWork(unit)
  }

  /** Removes a bounded few stages no attempt owns, once nothing transfers. */
  private func sweepStages() {
    guard case .idle = slot, let ledger else { return }
    let owned = Set(ledger.authorizations.values.compactMap { $0.attempt?.token })
    let file = self.file
    io.async {
      for orphan in file.orphanStages(owned: owned) { try? FileManager.default.removeItem(at: orphan) }
    }
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
