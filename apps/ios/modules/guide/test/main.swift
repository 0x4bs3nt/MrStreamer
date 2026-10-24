import Foundation

@main struct GuideFixtures {
  static func require(_ condition: @autoclosure () -> Bool, _ label: String) throws {
    if !condition() { throw GuideFailure(label) }
  }
  static func value(_ result: [String: Any]) throws -> [String: Any] {
    guard result["kind"] as? String == "ok", let value = result["value"] as? [String: Any] else {
      throw GuideFailure("fixture-result-" + (result["error"] as? String ?? result["kind"] as? String ?? "missing"))
    }
    return value
  }
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
    owner.ingestQueue.async {
      cancelledDownload = owner.prepare(lease, "cancel-download", base + "/slow", [:], ["fixture", "canary-secret"], now, now - 86400000, now + 7 * 86400000)
      finished.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)
    owner.cancel("cancel-download")
    try require(finished.wait(timeout: .now() + 3) == .success, "cancel-completion")
    try require(cancelledDownload["kind"] as? String == "cancelled", "cancel-download")
    owner.finish("cancel-download")
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
    try require(restart.forget("provider-a"), "forget")
    let new = try restart.attach("provider-a", 1)
    try require(new["generation"] is NSNull, "revision-process-only")
    let denied = restart.restore([])
    try require(denied.isEmpty && !fm.fileExists(atPath: root.appendingPathComponent("provider-b").path), "allowlist")
    print("PASS production-core fixtures: plain chunks gzip members CRC truncation XML DTD attributes depth empty ended login text redirects timeline restart last-good source collisions revoke forget allowlist")
  }
}
