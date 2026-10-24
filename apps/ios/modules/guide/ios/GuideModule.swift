import ExpoModulesCore

public final class GuideModule: Module {
  private let owner: GuideOwner? = {
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
    return try? GuideOwner(root: caches.appendingPathComponent("guides", isDirectory: true))
  }()
  public func definition() -> ModuleDefinition {
    Name("Guide")
    Events("foreground", "background")
    OnAppEntersForeground { self.sendEvent("foreground") }
    OnAppEntersBackground { self.owner?.background(); self.sendEvent("background") }
    Function("begin") { (lease: String, job: String) in self.owner?.begin(lease, job) }
    Function("revoke") { (id: String) in self.owner?.revoke(id) }
    AsyncFunction("restore") { (ids: [String], promise: Promise) in
      guard let owner = self.owner else { promise.reject("unavailable", "unavailable"); return }
      owner.ingestQueue.async { promise.resolve(owner.restore(ids)) }
    }
    AsyncFunction("attach") { (id: String, revision: Int, promise: Promise) in
      guard let owner = self.owner else { promise.reject("unavailable", "unavailable"); return }
      owner.ingestQueue.async {
        do { promise.resolve(try owner.attach(id, revision)) } catch { promise.reject("unavailable", "unavailable") }
      }
    }
    AsyncFunction("forget") { (id: String, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(false); return }
      owner.revoke(id)
      owner.reads.addBarrierBlock { owner.ingestQueue.async { promise.resolve(owner.forget(id)) } }
    }
    AsyncFunction("cancel") { (job: String, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(); return }
      owner.cancel(job)
      owner.reads.addBarrierBlock { owner.ingestQueue.async { owner.finish(job); promise.resolve() } }
    }
    AsyncFunction("prepare") { (lease: String, job: String, url: String, headers: [String: String], login: [String], now: Double, from: Double, until: Double, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(["kind": "failed", "error": "unavailable"]); return }
      owner.ingestQueue.async { promise.resolve(owner.prepare(lease, job, url, headers, login, now, from, until)) }
    }
    AsyncFunction("publish") { (lease: String, job: String, candidate: String, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(["kind": "failed", "error": "unavailable"]); return }
      owner.ingestQueue.async { promise.resolve(owner.publish(lease, job, candidate)) }
    }
    AsyncFunction("query") { (lease: String, generation: String, job: String, ids: [String], at: Double, mode: String, from: Double, until: Double, after: Double, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(["kind": "failed", "error": "unavailable"]); return }
      owner.reads.addOperation { promise.resolve(owner.query(lease, generation, job, ids, at, mode, from, until, after)) }
    }
  }
}
