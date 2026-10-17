import Foundation

/**
 How an attempt ended, in fixed terms only: kinds, an HTTP status, an NSURLErrorDomain code and
 sizes. Never an address, a header, a login or the system's wording, since it is written to disk.
 */
struct Outcome: Codable {
  enum Kind: String, Codable {
    /// Every byte is in place as `media.<ext>`, of `size` bytes; `expected` is the whole file's
    /// size as the server announced it, the total of a range answer included.
    case complete
    /// Paused on request; `resumable` once its resume data is in the Keychain.
    case paused
    /// Cancelled on request: removed, or the queue gave up on it.
    case cancelled
    /// The server answered `status` outside 2xx.
    case refused
    /// The file couldn't be moved into its folder.
    case folder
    /// The request broke: `code` in NSURLErrorDomain (0 for any other cause), `resumable` once
    /// URLSession's resume data for it is in the Keychain.
    case network
  }

  let kind: Kind
  var size: Int64? = nil
  var expected: Int64? = nil
  var status: Int? = nil
  var code: Int? = nil
  var resumable: Bool? = nil

  static let cancelled = Outcome(kind: .cancelled)
  static let folder = Outcome(kind: .folder)
  static func network(_ code: Int, resumable: Bool) -> Outcome {
    Outcome(kind: .network, code: code, resumable: resumable)
  }

  var dictionary: [String: Any] {
    var body: [String: Any] = ["kind": kind.rawValue]
    switch kind {
    case .complete:
      body["size"] = size ?? 0
      body["expected"] = expected.map { $0 as Any } ?? NSNull()
    case .paused:
      body["resumable"] = resumable ?? false
    case .refused:
      body["status"] = status ?? 0
    case .network:
      body["code"] = code ?? 0
      body["resumable"] = resumable ?? false
    case .cancelled, .folder:
      break
    }
    return body
  }
}

/** What a file being finished holds, written down before it is moved into place. */
struct Finishing: Codable {
  let size: Int64
  let expected: Int64?
}

/** One authorized request for one download: the only kind the owner moves a file for. */
struct Attempt: Codable {
  let id: String
  let ext: String
  /// The URLSession task's identifier, unique within the session across launches.
  let task: Int
  /// Whether it goes on from resume data.
  let resumed: Bool
  /// Set once the task was resumed; an attempt never resumed has no request to wait for.
  var started = false
  /// Removed or given up: its file is never moved into place.
  var revoked = false
  var finishing: Finishing? = nil
}

/** How an attempt ended, kept until JavaScript says it wrote it down. */
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
  /// Attempts whose request may still be open, by attempt token.
  var attempts: [String: Attempt] = [:]
  var receipts: [Receipt] = []
}

/**
 The ledger's file in Application Support, written whole and atomically, readable after the
 first unlock since a restart and kept out of backups.
 */
struct LedgerFile {
  enum Read {
    /// No file: a new install.
    case none
    case read(Ledger)
    /// The file is there but can't be read now, as before the first unlock.
    case unavailable
    /// The file reads but isn't a ledger: nothing it names can be trusted.
    case corrupt
  }

  private let folder: URL? = FileManager.default
    .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
    .appendingPathComponent("BackgroundDownloads", isDirectory: true)
  private var url: URL? { folder?.appendingPathComponent("ledger.json") }

  func read() -> Read {
    guard let url else { return .unavailable }
    guard FileManager.default.fileExists(atPath: url.path) else { return .none }
    guard let data = try? Data(contentsOf: url) else { return .unavailable }
    guard let ledger = try? JSONDecoder().decode(Ledger.self, from: data), ledger.version == 1
    else { return .corrupt }
    return .read(ledger)
  }

  func write(_ ledger: Ledger) -> Bool {
    guard var folder, let url, let data = try? JSONEncoder().encode(ledger) else { return false }
    do {
      try FileManager.default.createDirectory(
        at: folder,
        withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
      )
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      return true
    } catch {
      return false
    }
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
  static func isExtension(_ value: String) -> Bool { matches(value, "^[a-z0-9]{1,8}$") }

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
}
