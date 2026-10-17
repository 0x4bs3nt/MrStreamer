import Foundation
import Security

/**
 URLSession's resume data for each download, kept only here: a Keychain item per download id, on
 this device alone, readable after the first unlock since a restart. The data names the request's
 address, login included, so it is a secret; so is `url`, the address it was made for, which a
 start compares with the address it is given now before going on from it.
 */
struct ResumeSecrets {
  private static let service = "app.mrstreamer.downloads"

  enum Read {
    case found(data: Data, url: String)
    case missing
    /// The Keychain wouldn't answer, as while locked before the first unlock: not "missing".
    case unavailable
  }

  private struct Item: Codable {
    let url: String
    let data: Data
  }

  private func query(_ id: String? = nil) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
    ]
    if let id { query[kSecAttrAccount as String] = id }
    return query
  }

  func read(_ id: String) -> Read {
    var query = query(id)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess, let bytes = found as? Data else { return .unavailable }
    // An item that doesn't decode can't be gone on from: as good as none.
    guard let item = try? JSONDecoder().decode(Item.self, from: bytes) else { return .missing }
    return .found(data: item.data, url: item.url)
  }

  func write(_ id: String, url: String, data: Data) -> Bool {
    guard !url.isEmpty, let bytes = try? JSONEncoder().encode(Item(url: url, data: data)) else {
      return false
    }
    let update = SecItemUpdate(query(id) as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
    if update == errSecSuccess { return true }
    guard update == errSecItemNotFound else { return false }
    var add = query(id)
    add[kSecValueData as String] = bytes
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  /** True once the download has no item, whether it had one or not. */
  func remove(_ id: String) -> Bool {
    let status = SecItemDelete(query(id) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }

  /** Removes every download's item, as a new install does with what an earlier one left. */
  func removeAll() -> Bool {
    let status = SecItemDelete(query() as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }

  func has(_ id: String) -> Bool {
    if case .found = read(id) { return true }
    return false
  }
}
