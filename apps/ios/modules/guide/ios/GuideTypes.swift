import Foundation
import SQLite3

// Refusals, not measured phone-safe capacities. Total includes old generations and spools.
enum GuideBudget {
  static let body: Int64 = 32 * 1024 * 1024
  static let plain: Int64 = 64 * 1024 * 1024
  static let database: Int64 = 32 * 1024 * 1024
  static let disk: Int64 = 256 * 1024 * 1024
  static let free: Int64 = 256 * 1024 * 1024
  static let token = 65536
  static let rows = 250000
  static let channels = 10000
}
struct GuideFailure: Error { let code: String; init(_ code: String) { self.code = code } }
struct GuideGeneration: Codable {
  let id: String
  let fetchedAt: Double
  let until: Double
  var payload: [String: Any] { ["id": id, "fetchedAt": fetchedAt, "until": until] }
}
struct GuideActivation {
  let lease: String
  let revision: Int
  var generation: GuideGeneration?
  var payload: [String: Any] { ["lease": lease, "generation": generation.map { $0.payload as Any } ?? NSNull()] }
}
final class GuideJob {
  let id: String
  let lease: String
  let deadline: TimeInterval
  private let lock = NSLock()
  private var cancelled = false
  var task: URLSessionTask?
  init(_ id: String, _ lease: String) {
    self.id = id; self.lease = lease
    self.deadline = ProcessInfo.processInfo.systemUptime + 180
  }
  func cancel() { lock.lock(); cancelled = true; let t = task; lock.unlock(); t?.cancel() }
  func setTask(_ next: URLSessionTask) { lock.lock(); task = next; let stop = cancelled; lock.unlock(); if stop { next.cancel() } }
  func check() throws {
    lock.lock(); let stop = cancelled; lock.unlock()
    if stop { throw GuideFailure("cancelled") }
    if ProcessInfo.processInfo.systemUptime > deadline { throw GuideFailure("time") }
  }
}
func guideResult(_ work: () throws -> [String: Any]) -> [String: Any] {
  do { return ["kind": "ok", "value": try work()] }
  catch let failure as GuideFailure {
    if failure.code == "changed" || failure.code == "cancelled" { return ["kind": failure.code] }
    return ["kind": "failed", "error": failure.code]
  } catch { return ["kind": "failed", "error": "disk"] }
}
func guideOpaque(_ value: String) -> Bool {
  !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
}
func guideFiles(_ root: URL) throws -> [URL] {
  try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey], options: [])
}
func guideDisk(_ root: URL) throws {
  let fm = FileManager.default
  var bytes: Int64 = 0
  if let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isSymbolicLinkKey]) {
    for case let file as URL in enumerator {
      let values = try file.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])
      if values.isSymbolicLink == true { throw GuideFailure("disk") }
      bytes += Int64(values.fileSize ?? 0)
      if bytes > GuideBudget.disk { throw GuideFailure("disk") }
    }
  }
  let attributes = try fm.attributesOfFileSystem(forPath: root.path)
  if (attributes[.systemFreeSize] as? NSNumber)?.int64Value ?? 0 < GuideBudget.free { throw GuideFailure("disk") }
}
