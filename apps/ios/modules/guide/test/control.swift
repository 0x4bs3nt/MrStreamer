import Foundation
import SQLite3

extension GuideFixtures {
  // These callbacks are the production dispatch entry points used directly by GuideModule.
  static func awaitValue<T>(_ label: String, _ start: (@escaping (T) -> Void) -> Void) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var output: T?
    start { output = $0; done.signal() }
    try require(done.wait(timeout: .now() + 2) == .success, "prompt-" + label)
    guard let output = output else { throw GuideFailure("callback-" + label) }
    return output
  }
  static func drain(_ owner: GuideOwner, _ job: String) throws {
    let _: Bool = try awaitValue("drain") { completion in owner.cancelAsync(job) { completion(true) } }
  }
  static func fetch(_ base: String, _ route: String) throws -> String {
    let config = URLSessionConfiguration.ephemeral
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let done = DispatchSemaphore(value: 0)
    var body: Data?
    session.dataTask(with: URL(string: base + route)!) { data, _, _ in body = data; done.signal() }.resume()
    try require(done.wait(timeout: .now() + 2) == .success, "fixture-http")
    return String(data: body ?? Data(), encoding: .utf8) ?? ""
  }
  static func controls(_ owner: GuideOwner, _ lease: String, _ db: String, _ root: URL, _ base: String, _ now: Double) throws {
    let b = try owner.attach("held-provider", 1)["lease"] as! String
    try require(owner.begin(b, "held-ingest"), "begin-held")
    let ingested = DispatchSemaphore(value: 0)
    var ingestResult = [String: Any]()
    owner.prepareAsync(b, "held-ingest", base + "/held", [:], [], now, now - 86400000, now + 7 * 86400000) { ingestResult = $0; ingested.signal() }
    let until = ProcessInfo.processInfo.systemUptime + 2
    while try fetch(base, "/held-state") != "yes" {
      try require(ProcessInfo.processInfo.systemUptime < until, "held-start")
      Thread.sleep(forTimeInterval: 0.01)
    }
    // More than the admission cap: every completed read must really retire its own job.
    for n in 0..<132 {
      let job = "prompt-read-" + String(n)
      try require(owner.begin(lease, job), "read-admission")
      let mode = n % 3 == 0 ? "listing" : n % 3 == 1 ? "day" : "detail"
      let result: [String: Any] = try awaitValue("cached-" + mode) { completion in
        owner.queryAsync(lease, db, job, ["trusted"], now, mode, now - 12 * 3600000, now + 12 * 3600000, now - 3600000, completion: completion)
      }
      _ = try value(result)
      try drain(owner, job)
    }
    let attached: Result<[String: Any], GuideFailure> = try awaitValue("unrelated-attach") { owner.attachAsync("short-provider", 1, completion: $0) }
    let c = try attached.get()["lease"] as! String
    try require(owner.begin(c, "queued-ingest"), "queued-admission")
    let queued = DispatchSemaphore(value: 0)
    var queuedResult = [String: Any]()
    owner.prepareAsync(c, "queued-ingest", base + "/plain", [:], [], now, now - 86400000, now + 7 * 86400000) { queuedResult = $0; queued.signal() }
    try drain(owner, "queued-ingest")
    try require(queued.wait(timeout: .now() + 2) == .success && queuedResult["kind"] as? String == "cancelled", "queued-cancel-completion")
    let forgotten: Bool = try awaitValue("unrelated-forget") { owner.forgetAsync("short-provider", completion: $0) }
    try require(forgotten && ingested.wait(timeout: .now()) == .timedOut, "unrelated-ingest-still-held")
    let erased: Bool = try awaitValue("own-forget-drain") { owner.forgetAsync("held-provider", completion: $0) }
    try require(erased && ingested.wait(timeout: .now() + 2) == .success && ingestResult["kind"] as? String == "cancelled", "own-resources-drained")
    _ = try fetch(base, "/release-held")
    try require(!FileManager.default.fileExists(atPath: root.appendingPathComponent("held-provider").path), "forget-no-partials")
    try require(owner.publish(b, "held-ingest", "invented")["kind"] as? String == "changed", "forget-no-late-publish")
    try require(owner.disk.inspect().open_files == 0, "read-files-closed")

    // Hold a real pinned query in its connection-open policy, then forget that provider.
    let pinnedLease = try owner.attach("pinned-provider", 1)["lease"] as! String
    owner.begin(pinnedLease, "pinned-build")
    let candidate = try value(owner.prepare(pinnedLease, "pinned-build", base + "/plain", [:], [], now, now - 86400000, now + 7 * 86400000))["id"] as! String
    let pinnedDB = try value(owner.publish(pinnedLease, "pinned-build", candidate))["id"] as! String
    try drain(owner, "pinned-build")
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    owner.disk.setPolicy { request in
      if request.flags & SQLITE_OPEN_READONLY != 0 { entered.signal(); _ = release.wait(timeout: .now() + 2) }
      return GuideIOLimits()
    }
    owner.begin(pinnedLease, "pinned-read")
    let readDone = DispatchSemaphore(value: 0), eraseDone = DispatchSemaphore(value: 0)
    var readResult = [String: Any](), erasedPinned = false
    owner.queryAsync(pinnedLease, pinnedDB, "pinned-read", ["trusted"], now, "listing", 0, 0, -1) { readResult = $0; readDone.signal() }
    try require(entered.wait(timeout: .now() + 2) == .success, "actual-query-pinned")
    owner.forgetAsync("pinned-provider") { erasedPinned = $0; eraseDone.signal() }
    try require(eraseDone.wait(timeout: .now() + 0.05) == .timedOut && FileManager.default.fileExists(atPath: root.appendingPathComponent("pinned-provider/" + pinnedDB + ".sqlite").path), "pin-not-deleted")
    owner.disk.setPolicy(nil); release.signal()
    try require(eraseDone.wait(timeout: .now() + 2) == .success && readDone.wait(timeout: .now() + 2) == .success && erasedPinned && readResult["kind"] as? String != "ok", "pin-drained-before-erase")

    let lowRoot = root.appendingPathComponent("low-space")
    let low = try GuideOwner(root: lowRoot, freeFloor: UInt64.max / 2)
    let noCache: Bool = try awaitValue("empty-low-space-forget") { low.forgetAsync("brand-new", completion: $0) }
    try require(noCache && (try guideFiles(lowRoot)).isEmpty, "no-unnecessary-marker")
    // Seed a real cache with the normal floor, then erase under an impossible growth floor.
    let normal = try GuideOwner(root: lowRoot)
    let normalLease = try normal.attach("cached", 1)["lease"] as! String
    normal.begin(normalLease, "seed")
    let seed = try value(normal.prepare(normalLease, "seed", base + "/plain", [:], [], now, now - 86400000, now + 7 * 86400000))["id"] as! String
    _ = try value(normal.publish(normalLease, "seed", seed)); try drain(normal, "seed")
    _ = low.restore(["cached"])
    let directory = lowRoot.appendingPathComponent("cached")
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
    let failedErase: Bool = try awaitValue("truthful-low-space-erase") { low.forgetAsync("cached", completion: $0) }
    try require(!failedErase && FileManager.default.fileExists(atPath: lowRoot.appendingPathComponent("cached.revoked").path), "low-space-durable-tombstone")
    do { _ = try low.attach("cached", 2); throw GuideFailure("failed-erase-readd") } catch let error as GuideFailure { try require(error.code == "disk", "failed-erase-blocked") }
    let restarted = try GuideOwner(root: lowRoot, freeFloor: UInt64.max / 2)
    try require(restarted.restore(["cached"]).isEmpty, "failed-erase-restart-refused")
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let lowErased: Bool = try awaitValue("low-space-real-cache-erase") { low.forgetAsync("cached", completion: $0) }
    try require(lowErased && (try low.attach("cached", 3))["generation"] is NSNull, "low-space-no-resurrection")
    try require(owner.disk.inspect().open_files == 0, "control-all-files-closed")
    print("PASS same production async controls: 132 reads/drains during held unrelated ingest, prompt attach/forget/queued cancellation, own ingest/pin closure, low-space no-cache/failed erase/tombstone/restart/re-add")
  }
  static func xmlHeaders(_ owner: GuideOwner, _ lease: String, _ base: String, _ now: Double) throws {
    var accepted = ["/doctype-system", "/doctype-public", "/encoding-quoted"]
    var rejected = ["/doctype-duplicate", "/doctype-late", "/doctype-large", "/entity"]
    for separator in ["space", "tab", "lf", "cr"] {
      accepted.append("/encoding-" + separator + "-UTF-8")
      rejected.append("/encoding-" + separator + "-ISO-8859-1")
    }
    for route in accepted + rejected {
      let job = "header-" + UUID().uuidString
      owner.begin(lease, job)
      let result = owner.prepare(lease, job, base + route, [:], [], now, now - 86400000, now + 7 * 86400000)
      if accepted.contains(route) { try require(try value(result)["kind"] as? String == "candidate", "header-accept-" + route) }
      else { try require(result["kind"] as? String == "failed", "header-refuse-" + route) }
      try drain(owner, job)
    }
    try require(try fetch(base, "/dtd-count") == "0", "zero-external-DTD-requests")
    print("PASS actual XMLParser: bounded external SYSTEM/PUBLIC, zero DTD fetch, subset/entity/duplicate/late/large refused; UTF-8 quoted/space/tab/LF/CR accepted, other encodings refused")
  }
}
