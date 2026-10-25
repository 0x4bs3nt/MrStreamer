import Foundation
import Security

/**
 The queue's protected request authority, kept only here: generic-password Keychain items on this
 device alone, readable after the first unlock since a restart, never synchronized.

 Each source has its own service, `app.mrstreamer.downloads.v2.<hex of its id>`, so deleting it
 touches no login, subtitle or other source's item. In it, `authority` is the source's anchor for
 the queue epoch and generation (no address); `request.<authorization>` is one authorization's
 exact file request; `resume.<download>` is URLSession's resume data with the request it was made
 for and the authorization that owns it. A request and resume data name the provider's address,
 login included, so they are secrets. Build 14's resume data, one item per download in
 `app.mrstreamer.downloads`, is read once to be taken over by a matching request.

 Every call blocks; the owner makes them on its I/O lane, never on its control queue or main.
 A Keychain that won't answer, as before the first unlock, is never taken for a missing item.
 */
struct Vault {
  static let legacyService = "app.mrstreamer.downloads"

  enum Read<Value> {
    case found(Value)
    /// No item, or one that doesn't decode: as good as none, never authority.
    case missing
    case unavailable
  }

  struct Anchor: Codable, Equatable {
    var version = 1
    let queueEpoch: String
    let sourceGeneration: String
  }

  struct Request: Codable, Equatable {
    var version = 1
    let authorization: String
    let sourceGeneration: String
    let url: String
    let headers: [String: String]
  }

  struct Resume: Codable {
    var version = 2
    let authorization: String
    let sourceGeneration: String
    let url: String
    let headers: [String: String]
    let data: Data
  }

  /** Build 14's item: the address its resume data was made for. */
  struct LegacyResume: Codable {
    let url: String
    let data: Data
  }

  static func service(_ source: String) -> String {
    "app.mrstreamer.downloads.v2." + source.utf8.map { String(format: "%02x", $0) }.joined()
  }

  private static func account(request authorization: String) -> String { "request.\(authorization)" }
  private static func account(resume download: String) -> String { "resume.\(download)" }

  // MARK: Items

  func anchor(_ source: String) -> Read<Anchor> { read(Self.service(source), "authority") }

  func setAnchor(_ source: String, _ anchor: Anchor) -> Bool {
    write(Self.service(source), "authority", anchor)
  }

  /** Deletes the anchor only while it still names `generation`. */
  func removeAnchor(_ source: String, generation: String) -> Bool {
    switch anchor(source) {
    case .found(let found) where found.sourceGeneration != generation: return true
    case .unavailable: return false
    default: return remove(Self.service(source), "authority")
    }
  }

  func request(_ source: String, _ authorization: String) -> Read<Request> {
    read(Self.service(source), Self.account(request: authorization))
  }

  func setRequest(_ source: String, _ request: Request) -> Bool {
    write(Self.service(source), Self.account(request: request.authorization), request)
  }

  func removeRequest(_ source: String, _ authorization: String) -> Bool {
    remove(Self.service(source), Self.account(request: authorization))
  }

  func resume(_ source: String, _ download: String) -> Read<Resume> {
    read(Self.service(source), Self.account(resume: download))
  }

  func setResume(_ source: String, _ download: String, _ resume: Resume) -> Bool {
    write(Self.service(source), Self.account(resume: download), resume)
  }

  /** Deletes a download's resume data, when `owner` is given only while that authorization owns it. */
  func removeResume(_ source: String, _ download: String, ownedBy owner: String? = nil) -> Bool {
    let service = Self.service(source)
    if let owner {
      let found: Read<Resume> = read(service, Self.account(resume: download))
      switch found {
      case .found(let resume) where resume.authorization != owner: return true
      case .unavailable: return false
      default: break
      }
    }
    return remove(service, Self.account(resume: download))
  }

  /** Deletes the source's whole service: its anchor, requests and resume data. */
  func removeSource(_ source: String) -> Bool { remove(Self.service(source), nil) }

  func legacy(_ download: String) -> Read<LegacyResume> { read(Self.legacyService, download) }

  func setLegacy(_ download: String, _ item: LegacyResume) -> Bool {
    write(Self.legacyService, download, item)
  }

  func removeLegacy(_ download: String) -> Bool { remove(Self.legacyService, download) }

  /** Deletes every build-14 item: that service is this module's own. */
  func removeAllLegacy() -> Bool { remove(Self.legacyService, nil) }

  // MARK: Keychain

  private func query(_ service: String, _ account: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
    ]
    if let account { query[kSecAttrAccount as String] = account }
    return query
  }

  private func read<Value: Decodable>(_ service: String, _ account: String) -> Read<Value> {
    var query = query(service, account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess, let bytes = found as? Data else { return .unavailable }
    guard let value = try? JSONDecoder().decode(Value.self, from: bytes) else { return .missing }
    return .found(value)
  }

  private func write<Value: Encodable>(_ service: String, _ account: String, _ value: Value) -> Bool {
    guard let bytes = try? JSONEncoder().encode(value) else { return false }
    let update = SecItemUpdate(
      query(service, account) as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
    if update == errSecSuccess { return true }
    guard update == errSecItemNotFound else { return false }
    var add = query(service, account)
    add[kSecValueData as String] = bytes
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    add[kSecAttrSynchronizable as String] = false
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  /** True once no matching item is left, whether there was one or not. */
  private func remove(_ service: String, _ account: String?) -> Bool {
    let status = SecItemDelete(query(service, account) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
