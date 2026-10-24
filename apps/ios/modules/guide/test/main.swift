import Foundation
import SQLite3

@main struct GuideFixtures {
  static func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
    if try !condition() { throw GuideFailure(label) }
  }
  static func value(_ result: [String: Any]) throws -> [String: Any] {
    guard result["kind"] as? String == "ok", let value = result["value"] as? [String: Any] else {
      throw GuideFailure("fixture-result-" + (result["error"] as? String ?? result["kind"] as? String ?? "missing"))
    }
    return value
  }
  static func phaseIsFinal(_ scenario: String) -> Bool { scenario.hasPrefix("finalize") }
  static func main() throws {
    let args = CommandLine.arguments
    guard args.count == 3 else { throw GuideFailure("arguments") }
    let root = URL(fileURLWithPath: args[1], isDirectory: true)
    let base = args[2]
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let now = 1792843200000.0
    let owner = try GuideOwner(root: root)
    let activation = try owner.attach("provider-a", 1)
    let lease = activation["lease"] as! String
    func prepare(_ route: String, _ job: String) -> [String: Any] {
      owner.begin(lease, job)
      return owner.prepare(lease, job, base + route, [:], ["fixture", "canary-secret"], now, now - 86400000, now + 7 * 86400000)
    }
    let candidate = try value(prepare("/plain", "plain"))["id"] as! String
    let generation = try value(owner.publish(lease, "plain", candidate))
    let db = generation["id"] as! String
    owner.finish("plain")
    owner.begin(lease, "q1")
    let listing = try value(owner.query(lease, db, "q1", ["absent", "trusted", "alternate"], now, "listing", 0, 0, -1))
    let rows = listing["rows"] as! [[String: Any]]
    try require(listing["guideId"] as? String == "trusted", "first-trusted")
    try require(rows.count == 2 && rows[0]["title"] as? String == "News & weather", "entities")
    try require(rows[0]["stop"] as? Double == now + 3600000, "overlap")
    try require(rows[1]["stop"] as? Double == now + 7200000, "missing-stop")
    owner.finish("q1")
    try require(guideTime("20261024120000") == now, "UTC-default")
    try require(guideTime("20260230010000 +0000") == nil, "invalid-calendar")
    try require(guideTime("20261025023000 +0100")! - guideTime("20261025023000 +0200")! == 3600000, "DST-offset")
    owner.begin(lease, "gap")
    let gap = try value(owner.query(lease, db, "gap", ["gap", "trusted"], now, "listing", 0, 0, -1))
    let gapRows = gap["rows"] as! [[String: Any]]
    try require(gap["guideId"] as? String == "gap" && gapRows.count == 1 && gapRows[0]["start"] as? Double == now + 3600000, "gap-no-fill")
    owner.finish("gap")
    let pageActivation = try owner.attach("pages-provider", 1)
    let pageLease = pageActivation["lease"] as! String
    owner.begin(pageLease, "pages")
    let pageCandidate = try value(owner.prepare(pageLease, "pages", base + "/pages", [:], ["fixture", "canary-secret"], now, now - 86400000, now + 7 * 86400000))["id"] as! String
    let pageGeneration = try value(owner.publish(pageLease, "pages", pageCandidate))["id"] as! String
    owner.finish("pages")
    owner.begin(pageLease, "day1")
    let firstPage = try value(owner.query(pageLease, pageGeneration, "day1", ["pages"], now, "day", now - 12 * 3600000, now + 12 * 3600000, -1))
    let firstRows = firstPage["rows"] as! [[String: Any]]
    try require(firstRows.count == 128 && firstPage["more"] as? Bool == true && firstRows[0]["description"] is NSNull, "bounded-day")
    owner.finish("day1")
    let lastStart = firstRows.last!["start"] as! Double
    owner.begin(pageLease, "day2")
    let secondPage = try value(owner.query(pageLease, pageGeneration, "day2", ["pages"], now, "day", now - 12 * 3600000, now + 12 * 3600000, lastStart))
    try require((secondPage["rows"] as! [[String: Any]]).count == 2 && secondPage["more"] as? Bool == false, "day-continuation")
    owner.finish("day2")
    owner.begin(pageLease, "detail")
    let detail = try value(owner.query(pageLease, pageGeneration, "detail", ["pages"], now, "detail", 0, 0, lastStart))
    try require((detail["rows"] as! [[String: Any]])[0]["description"] as? String == "Details 127", "bounded-detail")
    owner.finish("detail")

    for route in ["/gzip", "/members", "/http-gzip", "/double-gzip", "/chunks", "/split-gzip"] {
      let job = "fixture-" + UUID().uuidString
      let value = try value(prepare(route, job))
      try require(value["kind"] as? String == "candidate", "decode")
      owner.finish(job)
    }
    for (route, code) in [("/bad-crc", "gzip"), ("/truncated-gzip", "gzip"), ("/malformed", "xml"), ("/dtd", "xml"), ("/attributes", "element"), ("/empty", "empty"), ("/ended", "ended"), ("/secret", "xml"), ("/depth", "depth"), ("/html", "xml")] {
      let job = "reject-" + UUID().uuidString
      let result = prepare(route, job)
      try require(result["error"] as? String == code, "rejection-" + code)
      owner.finish(job)
    }
    // A username within prose is not a password; this matches catalogue-cache's holds policy.
    let safe = try value(prepare("/false-positive", "prose"))
    try require(safe["kind"] as? String == "candidate", "username-prose")
    owner.finish("prose")
    let redirect = try value(prepare("/redirect", "redirect"))
    try require(redirect["kind"] as? String == "redirect", "no-auto-redirect")
    owner.finish("redirect")
    let login = prepare("/login", "login")
    try require(login["error"] as? String == "login", "login")
    owner.finish("login")
    let staged = try value(prepare("/plain", "cancelled"))["id"] as! String
    owner.cancel("cancelled")
    try require(owner.publish(lease, "cancelled", staged)["kind"] as? String == "cancelled", "cancel-publish")
    owner.finish("cancelled")
    let ready = try value(prepare("/plain", "failed-write"))["id"] as! String
    let manifest = root.appendingPathComponent("provider-a/manifest.json")
    let manifestBytes = try Data(contentsOf: manifest)
    try fm.removeItem(at: manifest)
    try fm.createDirectory(at: manifest, withIntermediateDirectories: false)
    let failedWrite = owner.publish(lease, "failed-write", ready)
    try require(failedWrite["kind"] as? String == "failed", "failed-write")
    try fm.removeItem(at: manifest)
    try manifestBytes.write(to: manifest, options: .atomic)
    owner.finish("failed-write")
    owner.begin(lease, "cancel-download")
    let finished = DispatchSemaphore(value: 0)
    var cancelledDownload = [String: Any]()
    owner.prepareAsync(lease, "cancel-download", base + "/slow", [:], ["fixture", "canary-secret"], now, now - 86400000, now + 7 * 86400000) {
      cancelledDownload = $0
      finished.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)
    owner.cancel("cancel-download")
    try require(finished.wait(timeout: .now() + 3) == .success, "cancel-completion")
    try require(cancelledDownload["kind"] as? String == "cancelled", "cancel-download")
    owner.finish("cancel-download")
    try controls(owner, lease, db, root, base, now)
    try xmlHeaders(owner, lease, base, now)
    let beforeResources = try Data(contentsOf: manifest)
    for scenario in ["normalize-total", "normalize-free", "finalize-total", "normalize-cancel", "finalize-cancel"] {
      var growths = 0
      var injected = false
      var finalFlags = Set<Int32>()
      var finalGrowths = 0
      let beforeStats = owner.disk.inspect()
      owner.disk.setPolicy { request in
        if request.phase == "finalize" && request.growth > 0 { finalFlags.insert(request.flags); finalGrowths += 1 }
        let isScratch = request.flags & (SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_TRANSIENT_DB | SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_SUBJOURNAL) != 0
        let phase = scenario.hasPrefix("normalize") ? "normalize" : "finalize"
        if request.phase != phase || request.growth == 0 || (phase == "finalize" && !isScratch && request.flags & SQLITE_OPEN_MAIN_DB == 0) { return GuideIOLimits() }
        growths += 1
        if growths < 3 { return GuideIOLimits() }
        injected = true
        if scenario.hasSuffix("cancel") { return GuideIOLimits(cancel: true) }
        if scenario.hasSuffix("free") { return GuideIOLimits(available: UInt64(GuideBudget.free) + request.growth - 1) }
        return GuideIOLimits(total: request.used + request.growth - 1)
      }
      let job = "resource-" + scenario
      let result = prepare("/resources", job)
      owner.disk.setPolicy(nil)
      try require(injected, "resource-fault-not-preflight-" + scenario + "-flags-" + finalFlags.sorted().map(String.init).joined(separator: "-") + "-growths-" + String(finalGrowths))
      if scenario.hasSuffix("cancel") {
        try require(result["kind"] as? String == "cancelled", "cancelled-sql")
        try require(owner.publish(lease, job, "invented")["kind"] as? String == "cancelled", "cancel-lease-publish")
      } else {
        try require(result["error"] as? String == "disk", "resource-refusal")
        try require(owner.publish(lease, job, "invented")["kind"] as? String == "changed", "no-candidate-publish")
      }
      owner.finish(job)
      let afterResources = try Data(contentsOf: manifest)
      try require(afterResources == beforeResources, "exact-last-good-manifest")
      owner.begin(lease, "last-good-" + scenario)
      let kept = try value(owner.query(lease, db, "last-good-" + scenario, ["trusted"], now, "listing", 0, 0, -1))
      try require((kept["rows"] as! [[String: Any]])[0]["title"] as? String == "News & weather", "last-good-query")
      owner.finish("last-good-" + scenario)
      let stats = owner.disk.inspect()
      try require(stats.open_files == 0 && stats.temp_files == 0 && stats.sql_growth > beforeStats.sql_growth, "closed-sql-resources")
      if phaseIsFinal(scenario) { try require(finalFlags.contains(where: { $0 & SQLITE_OPEN_MAIN_DB != 0 }), "actual-finalization-file") }
      let remaining = try guideFiles(root).filter { $0.lastPathComponent.hasPrefix(".guide-") }
      let accountFiles = try guideFiles(root.appendingPathComponent("provider-a"))
      try require(remaining.isEmpty && accountFiles.allSatisfy { $0.lastPathComponent == "manifest.json" || $0.lastPathComponent == db + ".sqlite" }, "failed-job-owned-cleanup")
      print("PASS resource refusal/cleanup/last-good", scenario, "after", growths, "growth checks")
    }
    let statsBeforeSuccess = owner.disk.inspect()
    var normalizedGrowths = 0
    var compactedGrowths = 0
    owner.disk.setPolicy { request in
      if request.growth > 0 && request.phase == "normalize" { normalizedGrowths += 1 }
      if request.growth > 0 && request.phase == "finalize" && request.flags & SQLITE_OPEN_MAIN_DB != 0 { compactedGrowths += 1 }
      return GuideIOLimits()
    }
    let resourceCandidate = try value(prepare("/resources", "resource-success"))["id"] as! String
    owner.disk.setPolicy(nil)
    let statsAfterSuccess = owner.disk.inspect()
    try require(normalizedGrowths > 0 && compactedGrowths > 0 && statsAfterSuccess.sql_growth > statsBeforeSuccess.sql_growth && statsAfterSuccess.open_files == 0, "normal-sql-and-compaction-not-disabled")
    owner.cancel("resource-success")
    try require(owner.publish(lease, "resource-success", resourceCandidate)["kind"] as? String == "cancelled", "resource-success-not-published")
    owner.finish("resource-success")
    // Failed refresh never changed the manifest. Restart prunes orphan and follows only last-good.
    let orphan = root.appendingPathComponent("provider-a/orphan.part")
    try Data("fake".utf8).write(to: orphan)
    let restart = try GuideOwner(root: root)
    let restored = restart.restore(["provider-a"])
    try require(restored.count == 1 && !fm.fileExists(atPath: orphan.path), "restart-prune")
    let restoredActivation = restored[0]["activation"] as! [String: Any]
    let restoredGeneration = restoredActivation["generation"] as! [String: Any]
    try require(restoredGeneration["id"] as? String == db, "last-good")
    let other = try restart.attach("provider-b", 1)
    restart.begin(other["lease"] as! String, "collision")
    try require(restart.query(other["lease"] as! String, db, "collision", ["trusted"], now, "listing", 0, 0, -1)["kind"] as? String == "changed", "source-collision")
    restart.finish("collision")
    let restoredLease = restoredActivation["lease"] as! String
    restart.begin(restoredLease, "late")
    restart.revoke("provider-a")
    try require(restart.query(restoredLease, db, "late", ["trusted"], now, "listing", 0, 0, -1)["kind"] as? String == "changed", "late-query")
    let accountDirectory = root.appendingPathComponent("provider-a")
    try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: accountDirectory.path)
    try require(!restart.forget("provider-a"), "failed-delete")
    try require(fm.fileExists(atPath: root.appendingPathComponent("provider-a.revoked").path), "durable-revocation")
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: accountDirectory.path)
    let afterFailure = try GuideOwner(root: root)
    let deniedOld = afterFailure.restore(["provider-a"])
    let deniedActivation = deniedOld[0]["activation"] as! [String: Any]
    try require(deniedActivation["generation"] is NSNull, "no-resurrection")
    try require(restart.forget("provider-a"), "forget")
    let new = try restart.attach("provider-a", 1)
    try require(new["generation"] is NSNull, "revision-process-only")
    let denied = restart.restore([])
    try require(denied.isEmpty && !fm.fileExists(atPath: root.appendingPathComponent("provider-b").path), "allowlist")
    print("PASS production-core fixtures: plain chunks gzip members CRC truncation XML DTD attributes depth empty ended login text redirects timeline restart last-good source collisions revoke forget allowlist")
  }
}
