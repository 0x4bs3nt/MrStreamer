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
    Function("begin") { (lease: String, job: String) -> Bool in self.owner?.begin(lease, job) ?? false }
    Function("revoke") { (id: String) -> Void in self.owner?.revoke(id); return () }
    AsyncFunction("restore") { (ids: [String], promise: Promise) in
      guard let owner = self.owner else { promise.reject("unavailable", "unavailable"); return }
      owner.restoreAsync(ids) { promise.resolve($0) }
    }
    AsyncFunction("attach") { (id: String, revision: Int, promise: Promise) in
      guard let owner = self.owner else { promise.reject("unavailable", "unavailable"); return }
      owner.attachAsync(id, revision) { result in
        switch result {
        case .success(let value): promise.resolve(value)
        case .failure: promise.reject("unavailable", "unavailable")
        }
      }
    }
    AsyncFunction("forget") { (id: String, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(false); return }
      owner.forgetAsync(id) { promise.resolve($0) }
    }
    AsyncFunction("cancel") { (job: String, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(); return }
      owner.cancelAsync(job) { promise.resolve() }
    }
    AsyncFunction("prepare") { (lease: String, job: String, url: String, headers: [String: String], login: [String], now: Double, from: Double, until: Double, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(["kind": "failed", "error": "unavailable"]); return }
      owner.prepareAsync(lease, job, url, headers, login, now, from, until) { promise.resolve($0) }
    }
    AsyncFunction("publish") { (lease: String, job: String, candidate: String, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(["kind": "failed", "error": "unavailable"]); return }
      owner.publishAsync(lease, job, candidate) { promise.resolve($0) }
    }
    AsyncFunction("query") { (lease: String, generation: String, job: String, ids: [String], at: Double, mode: String, from: Double, until: Double, after: Double, promise: Promise) in
      guard let owner = self.owner else { promise.resolve(["kind": "failed", "error": "unavailable"]); return }
      owner.queryAsync(lease, generation, job, ids, at, mode, from, until, after) { promise.resolve($0) }
    }
  }
}
