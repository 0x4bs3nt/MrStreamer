import Foundation
import SQLite3

struct GuideIORequest {
  let phase: String
  let flags: Int32
  let used: UInt64
  let growth: UInt64
}
struct GuideIOLimits {
  var total: UInt64? = nil
  var available: UInt64? = nil
  var cancel = false
}

/** Shared by every connection and spool of the one native owner. The optional policy lets
    native fixtures inject a lower capacity at the real growth boundary, without real disk fills. */
final class GuideDisk {
  let raw: OpaquePointer
  private let policyLock = NSLock()
  private var policy: ((GuideIORequest) -> GuideIOLimits)?
  init(root: URL, freeFloor: UInt64 = UInt64(GuideBudget.free)) throws {
    guard let raw = mr_guide_disk_create(root.path, UInt64(GuideBudget.disk), freeFloor, UInt64(GuideBudget.database)) else { throw GuideFailure("disk") }
    self.raw = raw
  }
  deinit { mr_guide_disk_destroy(raw) }
  func setPolicy(_ policy: ((GuideIORequest) -> GuideIOLimits)?) { policyLock.lock(); self.policy = policy; policyLock.unlock() }
  func limits(_ request: GuideIORequest) -> GuideIOLimits {
    policyLock.lock(); let current = policy; policyLock.unlock()
    return current?(request) ?? GuideIOLimits()
  }
  func check() throws { if mr_guide_disk_check(raw) != SQLITE_OK { throw GuideFailure("disk") } }
  func open(_ file: URL) throws -> FileHandle {
    let fd = mr_guide_disk_open(raw, file.path)
    if fd < 0 { throw GuideFailure("disk") }
    return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
  }
  func write(_ data: Data, to file: URL, handle: FileHandle) throws {
    let code = data.withUnsafeBytes { mr_guide_disk_write(raw, file.path, handle.fileDescriptor, $0.baseAddress, $0.count) }
    if code != SQLITE_OK { throw GuideFailure("disk") }
  }
  func atomic(_ data: Data, to file: URL) throws {
    let code = data.withUnsafeBytes { mr_guide_disk_atomic(raw, file.path, $0.baseAddress, $0.count) }
    if code != SQLITE_OK { throw GuideFailure("disk") }
  }
  func replace(_ source: URL, with target: URL) throws {
    if mr_guide_disk_replace(raw, source.path, target.path) != SQLITE_OK { throw GuideFailure("disk") }
  }
  func inspect() -> mr_guide_disk_stats { mr_guide_disk_inspect(raw) }
}

private final class GuideIOState {
  let disk: GuideDisk
  let job: GuideJob
  var phase = "parse"
  init(disk: GuideDisk, job: GuideJob) { self.disk = disk; self.job = job }
}

/** Connection-private non-default VFS. GuideIndex closes all statements and the DB before
    this object releases its C registration and its strong job/disk references. */
final class GuideConnection {
  private let state: GuideIOState
  let raw: OpaquePointer
  var phase: String {
    get { state.phase }
    set { state.phase = newValue }
  }
  init(disk: GuideDisk, job: GuideJob) throws {
    let state = GuideIOState(disk: disk, job: job)
    self.state = state
    guard let raw = mr_guide_vfs_create(disk.raw, { context, flags, used, growth, total, available in
      guard let context = context else { return 1 }
      let state = Unmanaged<GuideIOState>.fromOpaque(context).takeUnretainedValue()
      do {
        try state.job.check()
        let limits = state.disk.limits(GuideIORequest(phase: state.phase, flags: flags, used: used, growth: growth))
        if limits.cancel { state.job.cancel(); return 1 }
        if let limit = limits.total, let total = total { total.pointee = min(total.pointee, limit) }
        if let limit = limits.available, let available = available { available.pointee = min(available.pointee, limit) }
        return 0
      } catch { return 1 }
    }, Unmanaged.passUnretained(state).toOpaque()) else { throw GuideFailure("disk") }
    self.raw = raw
  }
  var name: UnsafePointer<CChar>? { mr_guide_vfs_name(raw) }
  deinit {
    let code = mr_guide_vfs_destroy(raw)
    assert(code == SQLITE_OK, "Guide connection closed with live files")
  }
}
