import Foundation

/**
 How an authorization's request ended, in fixed terms only: kinds, an HTTP status, an
 NSURLErrorDomain code and sizes. Never an address, a header, a login or the system's wording,
 since it is written to disk.
 */
enum OutcomeV2: Equatable {
  /// Every byte is in place as `media.<ext>`, of `size` bytes; `expected` is the whole file's size
  /// as the server announced it, the total of a range answer included.
  case complete(size: Int64, expected: Int64?)
  /// Paused for playback, the same authorization still runnable; `resumable` once its resume
  /// data is kept.
  case paused(resumable: Bool)
  /// Removed by its caller: never queued again.
  case cancelled
  /// The server answered `status` outside 2xx.
  case refused(status: Int)
  /// The file couldn't be moved into its folder.
  case folder
  /// The disk lacked `needed` bytes for the rest.
  case diskFull(needed: Int64?)
  /// The request broke: `code` in NSURLErrorDomain (0 for any other cause).
  case network(code: Int, resumable: Bool)
  /// The authority it ran under ended: its source was revoked, its request item is gone, or its
  /// resume data was refused with no fresh start left.
  case refresh(Refresh)

  enum Refresh: String, Codable {
    case source
    case secretMissing = "secret-missing"
    case resumeUnusable = "resume-unusable"
  }

  var dictionary: [String: Any] {
    switch self {
    case .complete(let size, let expected):
      return ["kind": "complete", "size": size, "expected": expected.map { $0 as Any } ?? NSNull()]
    case .paused(let resumable): return ["kind": "paused", "resumable": resumable]
    case .cancelled: return ["kind": "cancelled"]
    case .refused(let status): return ["kind": "refused", "status": status]
    case .folder: return ["kind": "folder"]
    case .diskFull(let needed):
      return ["kind": "disk-full", "needed": needed.map { $0 as Any } ?? NSNull()]
    case .network(let code, let resumable):
      return ["kind": "network", "code": code, "resumable": resumable]
    case .refresh(let reason): return ["kind": "refresh", "reason": reason.rawValue]
    }
  }
}

extension OutcomeV2: Codable {
  private enum Key: String, CodingKey { case kind, size, expected, resumable, status, needed, code, reason }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    switch try c.decode(String.self, forKey: .kind) {
    case "complete":
      self = .complete(
        size: try c.decode(Int64.self, forKey: .size),
        expected: try c.decodeIfPresent(Int64.self, forKey: .expected))
    case "paused": self = .paused(resumable: try c.decode(Bool.self, forKey: .resumable))
    case "cancelled": self = .cancelled
    case "refused": self = .refused(status: try c.decode(Int.self, forKey: .status))
    case "folder": self = .folder
    case "disk-full": self = .diskFull(needed: try c.decodeIfPresent(Int64.self, forKey: .needed))
    case "network":
      self = .network(
        code: try c.decode(Int.self, forKey: .code),
        resumable: try c.decode(Bool.self, forKey: .resumable))
    case "refresh": self = .refresh(try c.decode(Refresh.self, forKey: .reason))
    default:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "kind")
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    switch self {
    case .complete(let size, let expected):
      try c.encode("complete", forKey: .kind)
      try c.encode(size, forKey: .size)
      try c.encodeIfPresent(expected, forKey: .expected)
    case .paused(let resumable):
      try c.encode("paused", forKey: .kind)
      try c.encode(resumable, forKey: .resumable)
    case .cancelled: try c.encode("cancelled", forKey: .kind)
    case .refused(let status):
      try c.encode("refused", forKey: .kind)
      try c.encode(status, forKey: .status)
    case .folder: try c.encode("folder", forKey: .kind)
    case .diskFull(let needed):
      try c.encode("disk-full", forKey: .kind)
      try c.encodeIfPresent(needed, forKey: .needed)
    case .network(let code, let resumable):
      try c.encode("network", forKey: .kind)
      try c.encode(code, forKey: .code)
      try c.encode(resumable, forKey: .resumable)
    case .refresh(let reason):
      try c.encode("refresh", forKey: .kind)
      try c.encode(reason, forKey: .reason)
    }
  }
}

/** What a file being finished holds, written down before it is moved into place. */
struct Finishing: Codable {
  let size: Int64
  let expected: Int64?
}

/** A source's download authority in this queue epoch: its generation, enabled or revoked. */
struct SourceAuthority: Codable, Equatable {
  enum State: String, Codable { case enabled, revoked }
  var generation: String
  var state: State
}

/** The one request an authorization's task makes: persisted before the task is resumed. */
struct NativeAttempt: Codable {
  let token: String
  /// The URLSession task's identifier, unique within the session across launches.
  let task: Int
  /// Set once the task was resumed.
  var started: Bool
  /// Whether it goes on from resume data.
  let resumed: Bool
  /// The OS scheduling lower bound given to the task, epoch milliseconds. Not a start time.
  let earliestBeginDate: Int64
  var finishing: Finishing?
}

/**
 One exact file request a download's record authorized. `reserved` until armed with its request;
 `queued` or `paused` while runnable; `active` while its one attempt may have a request open;
 `terminal` once its last receipt is written, kept until that receipt is acknowledged.
 */
struct Grant: Codable {
  enum State: String, Codable { case reserved, queued, active, paused, terminal }
  /// The download it is for.
  let id: String
  let ext: String
  let sourceId: String
  let sourceGeneration: String
  let order: Int64
  var state: State
  var restarted: Bool
  /// One fresh start, without resume data, after the server refused to go on from it.
  var freshRestartRemaining: Int
  var lastSequence: Int64
  var attempt: NativeAttempt?
}

/** How an authorization's request ended, kept until JavaScript says it wrote it down. */
struct ReceiptV2: Codable {
  var version = 2
  let receipt: String
  let authorization: String
  let attempt: String?
  /// The download it is for.
  let id: String
  let sequence: Int64
  let received: Int64?
  let expected: Int64?
  let restarted: Bool
  let outcome: OutcomeV2

  var dictionary: [String: Any] {
    [
      "version": 2, "receipt": receipt, "authorization": authorization,
      "attempt": attempt.map { $0 as Any } ?? NSNull(), "id": id, "sequence": sequence,
      "received": received.map { $0 as Any } ?? NSNull(),
      "expected": expected.map { $0 as Any } ?? NSNull(), "restarted": restarted,
      "outcome": outcome.dictionary,
    ]
  }
}

// MARK: Build 14's ledger, read only to migrate it

/** How a build-14 attempt ended. */
struct Outcome: Codable {
  enum Kind: String, Codable { case complete, paused, cancelled, refused, folder, network }
  let kind: Kind
  var size: Int64? = nil
  var expected: Int64? = nil
  var status: Int? = nil
  var code: Int? = nil
  var resumable: Bool? = nil

  var dictionary: [String: Any] {
    var body: [String: Any] = ["kind": kind.rawValue]
    switch kind {
    case .complete:
      body["size"] = size ?? 0
      body["expected"] = expected.map { $0 as Any } ?? NSNull()
    case .paused: body["resumable"] = resumable ?? false
    case .refused: body["status"] = status ?? 0
    case .network:
      body["code"] = code ?? 0
      body["resumable"] = resumable ?? false
    case .cancelled, .folder: break
    }
    return body
  }
}

/** A build-14 attempt: no source authority, so build 15 never moves its file into place. */
struct Attempt: Codable {
  let id: String
  let ext: String
  let task: Int
  let resumed: Bool
  var started = false
  var revoked = false
  var finishing: Finishing? = nil
}

/** A build-14 receipt, taken in by JavaScript with build 14's meanings. */
struct Receipt: Codable {
  let receipt: String
  let attempt: String
  let id: String
  let outcome: Outcome

  var dictionary: [String: Any] {
    ["receipt": receipt, "attempt": attempt, "id": id, "outcome": outcome.dictionary]
  }
}

struct Ledger: Codable {
  var version = 1
  var attempts: [String: Attempt] = [:]
  var receipts: [Receipt] = []
}

/** Build 14's facts, copied into queue-v2.json before its ledger.json is emptied. */
struct LegacyFacts: Codable {
  var attempts: [String: Attempt] = [:]
  var receipts: [Receipt] = []
}

// MARK: queue-v2.json

/**
 The queue's durable authority: source generations, authorizations and receipts of one queue
 epoch (`install`), and build 14's facts not yet taken in. Every counter is a nonnegative safe
 integer; native-minted names only.
 */
struct LedgerV2: Codable {
  var version = 2
  let install: String
  var sequence: Int64 = 0
  var nextOrder: Int64 = 0
  var sources: [String: SourceAuthority] = [:]
  var authorizations: [String: Grant] = [:]
  var receipts: [ReceiptV2] = []
  var legacy = LegacyFacts()

  static func fresh() -> LedgerV2 { LedgerV2(install: Names.mint("q")) }

  /// Nonterminal authorizations, and receipts not yet acknowledged.
  var load: (authorizations: Int, receipts: Int) {
    (authorizations.values.filter { $0.state != .terminal }.count, receipts.count)
  }

  /** Whether every name and counter is one this owner writes. */
  var valid: Bool {
    version == 2 && Names.isEpoch(install) && Names.isCount(sequence) && Names.isCount(nextOrder)
      && sources.allSatisfy { Names.isSource($0.key) && Names.isGeneration($0.value.generation) }
      && authorizations.allSatisfy { $0.value.valid(as: $0.key) }
      && receipts.allSatisfy(\.valid)
  }
}

extension Grant {
  func valid(as authorization: String) -> Bool {
    Names.isAuthorization(authorization) && Names.isId(id) && Names.isExtension(ext)
      && Names.isSource(sourceId) && Names.isGeneration(sourceGeneration) && Names.isCount(order)
      && Names.isCount(lastSequence) && (freshRestartRemaining == 0 || freshRestartRemaining == 1)
      && attempt.map { Names.isAttempt($0.token) && $0.task >= 0 } ?? true
      && (attempt == nil || state == .active)
  }
}

extension ReceiptV2 {
  var valid: Bool {
    version == 2 && Names.isReceipt(receipt) && Names.isAuthorization(authorization)
      && attempt.map(Names.isAttempt) ?? true && Names.isId(id) && Names.isCount(sequence)
  }
}

/** Decodes a value where it can, leaving nil where it can't, so one bad entry hides no other. */
private struct Failable<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

private struct Envelope: Decodable {
  let version: Int
}

/** What can still be read of a damaged queue-v2.json: never authority, only facts to apply. */
struct Salvage {
  var receipts: [ReceiptV2] = []
  var legacy: [Receipt] = []
  /// Source ids it names, for the scope of a reset.
  var sources: [String] = []
  /// Whether some fact couldn't be read at all.
  var unreadable = true
  var raw: Data?
}

private struct Pieces: Decodable {
  let sources: [String: Failable<SourceAuthority>]?
  let authorizations: [String: Failable<Grant>]?
  let receipts: [Failable<ReceiptV2>]?
  let legacy: Failable<LegacyFacts>?
}

/**
 The queue's files in Application Support/BackgroundDownloads, each written whole and atomically,
 readable after the first unlock since a restart and kept out of backups: queue-v2.json, build
 14's ledger.json until it is emptied, one capped copy of a damaged queue, and the private stage
 of the one file being finished.
 */
struct LedgerFile {
  enum Read {
    /// No file.
    case none
    case read(LedgerV2)
    /// The file is there but can't be read now, as before the first unlock.
    case unavailable
    /// The file reads but isn't a ledger this build trusts: nothing it names authorizes anything.
    case corrupt(Salvage)
  }

  enum ReadV1 {
    case none
    case read(Ledger)
    case unavailable
    case corrupt
  }

  /// A damaged queue's copy is at most this big, with its wrapper.
  static let diagnosticLimit = 1_048_576

  let folder: URL? = FileManager.default
    .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
    .appendingPathComponent("BackgroundDownloads", isDirectory: true)
  private var v2: URL? { folder?.appendingPathComponent("queue-v2.json") }
  private var v1: URL? { folder?.appendingPathComponent("ledger.json") }
  private var diagnostic: URL? { folder?.appendingPathComponent("queue-v2.damaged.json") }
  private var stages: URL? { folder?.appendingPathComponent("stages", isDirectory: true) }

  func read() -> Read {
    guard let url = v2 else { return .unavailable }
    guard FileManager.default.fileExists(atPath: url.path) else { return .none }
    guard let data = try? Data(contentsOf: url) else { return .unavailable }
    if let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.version == 2,
      let ledger = try? JSONDecoder().decode(LedgerV2.self, from: data), ledger.valid
    {
      return .read(ledger)
    }
    return .corrupt(salvage(data))
  }

  /** Every fact of a damaged queue that reads on its own. */
  private func salvage(_ data: Data) -> Salvage {
    var found = Salvage(raw: data)
    guard let pieces = try? JSONDecoder().decode(Pieces.self, from: data) else { return found }
    let receipts = pieces.receipts ?? []
    found.receipts = receipts.compactMap(\.value).filter(\.valid)
    found.legacy = pieces.legacy?.value?.receipts ?? []
    found.sources = Array((pieces.sources ?? [:]).keys.filter(Names.isSource))
    for grant in (pieces.authorizations ?? [:]).values.compactMap(\.value)
    where Names.isSource(grant.sourceId) && !found.sources.contains(grant.sourceId) {
      found.sources.append(grant.sourceId)
    }
    found.unreadable =
      found.receipts.count != receipts.count || pieces.legacy?.value == nil
      || (pieces.authorizations ?? [:]).values.contains { $0.value == nil }
    return found
  }

  func readV1() -> ReadV1 {
    guard let url = v1 else { return .unavailable }
    guard FileManager.default.fileExists(atPath: url.path) else { return .none }
    guard let data = try? Data(contentsOf: url) else { return .unavailable }
    guard let ledger = try? JSONDecoder().decode(Ledger.self, from: data), ledger.version == 1
    else { return .corrupt }
    return .read(ledger)
  }

  func write(_ ledger: LedgerV2) -> Bool {
    guard let url = v2, let data = try? JSONEncoder().encode(ledger) else { return false }
    return put(data, at: url)
  }

  /** Leaves build 14 an empty ledger once its facts are copied and its requests ended. */
  func emptyV1() -> Bool {
    guard let url = v1, FileManager.default.fileExists(atPath: url.path),
      let data = try? JSONEncoder().encode(Ledger())
    else { return true }
    return put(data, at: url)
  }

  /**
   Keeps one copy of a damaged queue's bytes, replacing the last: its nonsecret ledger only, cut
   to fit `diagnosticLimit` with the cut said.
   */
  func keepDiagnostic(_ raw: Data?) -> Bool {
    guard let raw, let url = diagnostic else { return true }
    let room = (Self.diagnosticLimit - 256) / 4 * 3
    let kept = raw.prefix(room)
    let body: [String: Any] = [
      "version": 1, "size": raw.count, "truncated": kept.count < raw.count,
      "ledger": kept.base64EncodedString(),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: body) else { return false }
    return put(data, at: url)
  }

  private func prepared() throws -> URL {
    guard var folder else { throw CocoaError(.fileNoSuchFile) }
    try FileManager.default.createDirectory(
      at: folder, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try folder.setResourceValues(values)
    return folder
  }

  private func put(_ data: Data, at url: URL) -> Bool {
    do {
      _ = try prepared()
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      return true
    } catch {
      return false
    }
  }

  /**
   The private stage of attempt `token`'s file: kept out of backups and readable after the first
   unlock, never published until its finishing marker is written and authority checked again.
   */
  func stage(_ token: String) -> URL? {
    guard Names.isAttempt(token), let stages else { return nil }
    do {
      _ = try prepared()
      var folder = stages
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
    } catch {
      return nil
    }
    return stages.appendingPathComponent(token, isDirectory: false)
  }

  /** Stages no attempt in `owned` names, a bounded few per pass. */
  func orphanStages(owned: Set<String>, limit: Int = 8) -> [URL] {
    guard let stages,
      let names = try? FileManager.default.contentsOfDirectory(atPath: stages.path)
    else { return [] }
    return names.filter { Names.isAttempt($0) && !owned.contains($0) }.prefix(limit)
      .map { stages.appendingPathComponent($0, isDirectory: false) }
  }
}

/**
 Names the owner accepts, and the only places it writes media: `Documents/downloads/<id>/media.<ext>`
 for a download id and file type of the app's own forms, inside a folder JavaScript made. Nothing
 that resolves outside Documents/downloads, a symbolic link included, is written.
 */
enum Names {
  static func isId(_ value: String) -> Bool { matches(value, "^d-[a-z0-9-]{1,64}$") }
  static func isAttempt(_ value: String) -> Bool { matches(value, "^a-[a-z0-9-]{1,64}$") }
  static func isAuthorization(_ value: String) -> Bool { matches(value, "^z-[a-z0-9-]{1,64}$") }
  static func isGeneration(_ value: String) -> Bool { matches(value, "^g-[a-z0-9-]{1,64}$") }
  static func isEpoch(_ value: String) -> Bool { matches(value, "^q-[a-z0-9-]{1,64}$") }
  static func isReceipt(_ value: String) -> Bool { matches(value, "^r-[a-z0-9-]{1,64}$") }
  static func isLease(_ value: String) -> Bool { matches(value, "^p-[a-z0-9-]{1,64}$") }
  static func isExtension(_ value: String) -> Bool { matches(value, "^[a-z0-9]{1,8}$") }
  /** An opaque registry id: at most 128 bytes, no control characters. */
  static func isSource(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128
      && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
  }
  static func isCount(_ value: Int64) -> Bool { value >= 0 && value <= 9_007_199_254_740_991 }

  /** A fresh native name with `prefix`. */
  static func mint(_ prefix: String) -> String { "\(prefix)-\(UUID().uuidString.lowercased())" }

  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }

  private static var root: URL? {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
      .appendingPathComponent("downloads", isDirectory: true)
      .resolvingSymlinksInPath()
  }

  /** The download's folder, when it is there as a folder of its own inside Documents/downloads. */
  static func folder(_ id: String) -> URL? {
    guard isId(id), let root else { return nil }
    let folder = root.appendingPathComponent(id, isDirectory: true)
    guard
      let values = try? folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
      values.isDirectory == true, values.isSymbolicLink != true,
      folder.resolvingSymlinksInPath().deletingLastPathComponent().path == root.path
    else { return nil }
    return folder
  }

  /** Where the download's file goes, when its folder is there and the name isn't a link. */
  static func media(_ id: String, _ ext: String) -> URL? {
    guard isExtension(ext), let folder = folder(id) else { return nil }
    let media = folder.appendingPathComponent("media.\(ext)", isDirectory: false)
    if let values = try? media.resourceValues(forKeys: [.isSymbolicLinkKey]),
      values.isSymbolicLink == true
    {
      return nil
    }
    return media
  }

  static func size(of url: URL) -> Int64? {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
  }

  /** Bytes free for files the app needs, or nil when the system won't say. */
  static func free() -> Int64? {
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    return (try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
      .volumeAvailableCapacityForImportantUsage
  }
}
