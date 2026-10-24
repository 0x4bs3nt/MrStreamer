import Foundation

private final class GuideInflateContext {
  let job: GuideJob
  init(job: GuideJob) { self.job = job }
}

private final class GuideWork {
  let job: GuideJob
  let completion: ([String: Any]) -> Void
  var started = false // GuideOwner lock.
  init(job: GuideJob, completion: @escaping ([String: Any]) -> Void) { self.job = job; self.completion = completion }
}

/** Native publication, lease revocation and read pins share one lock. IO work uses utility queues. */
final class GuideOwner {
  let root: URL
  let disk: GuideDisk
  private let lock = NSRecursiveLock()
  private var sources = [String: GuideActivation]()
  private var jobs = [String: GuideJob]()
  private var candidates = [String: (owner: String, job: String, generation: GuideGeneration)]()
  private var pins = [URL: Int]()
  private var blocked = Set<String>()
  private var operations = [UUID: GuideWork]()
  private var restoring = false
  private let control = DispatchQueue(label: "mrstreamer.guide.control", qos: .utility)
  private let ingestQueue = DispatchQueue(label: "mrstreamer.guide.ingest", qos: .utility)
  private let reads: OperationQueue = { let queue = OperationQueue(); queue.maxConcurrentOperationCount = 2; queue.qualityOfService = .utility; return queue }()
  init(root: URL, freeFloor: UInt64 = UInt64(GuideBudget.free)) throws {
    self.root = root
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var excluded = root; var values = URLResourceValues(); values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    self.disk = try GuideDisk(root: root, freeFloor: freeFloor)
  }
  private func directory(_ id: String) throws -> URL {
    guard guideOpaque(id) else { throw GuideFailure("changed") }
    return root.appendingPathComponent(id, isDirectory: true)
  }
  private func revocation(_ id: String) throws -> URL {
    _ = try directory(id)
    return root.appendingPathComponent(id + ".revoked")
  }
  private func manifest(_ id: String) throws -> URL { try directory(id).appendingPathComponent("manifest.json") }
  private func file(_ id: String, _ generation: String, part: Bool = false) throws -> URL {
    guard guideOpaque(generation) else { throw GuideFailure("changed") }
    return try directory(id).appendingPathComponent(generation + (part ? ".part" : ".sqlite"))
  }
  private func readGeneration(_ id: String) -> GuideGeneration? {
    do {
      let dir = try directory(id)
      if FileManager.default.fileExists(atPath: try revocation(id).path) || FileManager.default.fileExists(atPath: dir.appendingPathComponent("revoked").path) { return nil }
      let path = try manifest(id)
      let size = try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      if size > 1024 { return nil }
      let generation = try JSONDecoder().decode(GuideGeneration.self, from: Data(contentsOf: path))
      guard guideOpaque(generation.id), generation.fetchedAt.isFinite, generation.until.isFinite else { return nil }
      let db = try file(id, generation.id)
      let bytes = try db.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      if bytes <= 0 || bytes > GuideBudget.database { return nil }
      let index = try GuideIndex(db, job: GuideJob(UUID().uuidString, "restore"), disk: disk, create: false)
      try index.integrity()
      return generation
    } catch { return nil }
  }
  private func prune(_ id: String, orphans: Bool = false) {
    guard let dir = try? directory(id), let files = try? guideFiles(dir) else { return }
    let keep = sources[id]?.generation?.id
    for path in files {
      if !orphans && path.pathExtension != "sqlite" { continue }
      if path.lastPathComponent == "manifest.json" || path.lastPathComponent == "revoked" || path.lastPathComponent == keep.map({ $0 + ".sqlite" }) || (pins[path] ?? 0) > 0 { continue }
      try? FileManager.default.removeItem(at: path)
    }
  }
  func restore(_ active: [String]) -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    for job in jobs.values { job.cancel() }; sources.removeAll(); candidates.removeAll()
    let allowed = Set(active.filter(guideOpaque))
    if let files = try? guideFiles(root) {
      for path in files where path.pathExtension != "revoked" && !allowed.contains(path.lastPathComponent) {
        do {
          try FileManager.default.removeItem(at: path)
          try? FileManager.default.removeItem(at: root.appendingPathComponent(path.lastPathComponent + ".revoked"))
        } catch { /* The active allowlist still refuses reads from retired identities. */ }
      }
    }
    var result = [[String: Any]]()
    for id in allowed {
      guard let dir = try? directory(id) else { continue }
      if FileManager.default.fileExists(atPath: dir.appendingPathComponent("revoked").path) || FileManager.default.fileExists(atPath: (try? revocation(id).path) ?? "") {
        if !forget(id) { continue }
      }
      let activation = GuideActivation(lease: UUID().uuidString, revision: 0, generation: readGeneration(id))
      sources[id] = activation; prune(id, orphans: true)
      result.append(["subscriptionId": id, "activation": activation.payload])
    }
    return result
  }
  func attach(_ id: String, _ revision: Int) throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    let dir = try directory(id)
    let marker = try revocation(id)
    if restoring || blocked.contains(id) || FileManager.default.fileExists(atPath: marker.path) || FileManager.default.fileExists(atPath: dir.appendingPathComponent("revoked").path) { throw GuideFailure("disk") }
    if let current = sources[id], current.revision == revision { return current.payload }
    if let current = sources[id] { for job in jobs.values where job.lease == current.lease { cancelLocked(job) } }
    let activation = GuideActivation(lease: UUID().uuidString, revision: revision, generation: sources[id]?.generation ?? readGeneration(id))
    sources[id] = activation
    return activation.payload
  }
  func revoke(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    blocked.insert(id)
    sources.removeValue(forKey: id)
    for job in jobs.values where job.owner == id { cancelLocked(job) }
  }
  func forget(_ id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    revoke(id)
    do {
      let dir = try directory(id), marker = try revocation(id)
      let fm = FileManager.default
      let busy = jobs.values.contains { $0.owner == id && $0.active.wait(timeout: .now()) != .success }
      let pinned = pins.keys.contains { $0.deletingLastPathComponent() == dir }
      if !fm.fileExists(atPath: dir.path) && !fm.fileExists(atPath: marker.path) && !busy && !pinned {
        blocked.remove(id)
        return true
      }
      // A zero-byte tombstone is metadata, not guide growth. OS errors still count.
      var marked = false
      do { try disk.atomic(Data(), to: marker); marked = true } catch { /* Deletion may still succeed. */ }
      if busy || pinned { return false }
      do {
        if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
      } catch { return false } // Keep a successfully written marker and the blocked identity.
      if marked || fm.fileExists(atPath: marker.path) { try fm.removeItem(at: marker) }
      blocked.remove(id)
      candidates = candidates.filter { $0.value.owner != id }
      return true
    } catch { return false }
  }
  @discardableResult
  func begin(_ lease: String, _ id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !restoring, guideOpaque(id), jobs[id] == nil, jobs.count < 128,
          let owner = sources.first(where: { $0.value.lease == lease })?.key else { return false }
    jobs[id] = GuideJob(id, lease, owner: owner)
    return true
  }
  private func cancelLocked(_ job: GuideJob) {
    job.closing = true; job.cancel()
    // Queued work has no resources to drain. Resolve it now, without waiting for its queue.
    let queued = operations.filter { $0.value.job === job && !$0.value.started }
    for (key, work) in queued {
      operations.removeValue(forKey: key)
      control.async { work.completion(["kind": "cancelled"]) }
    }
  }
  func cancel(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    if let job = jobs[id] { cancelLocked(job) }
  }
  private func retire(_ id: String, _ job: GuideJob) {
    lock.lock(); defer { lock.unlock() }
    guard jobs[id] === job else { return }
    if job.active.wait(timeout: .now()) != .success {
      job.active.notify(queue: control) { self.retire(id, job) }
      return
    }
    jobs.removeValue(forKey: id)
    let dropped = candidates.filter { $0.value.job == id }
    for (key, value) in dropped {
      if let path = try? file(value.owner, key, part: true) { try? FileManager.default.removeItem(at: path) }
      candidates.removeValue(forKey: key)
    }
  }
  func finish(_ id: String) {
    lock.lock(); let job = jobs[id]; lock.unlock()
    if let job = job { retire(id, job) }
  }
  func cancelAsync(_ id: String, completion: @escaping () -> Void) {
    lock.lock()
    guard let job = jobs[id] else { lock.unlock(); completion(); return }
    cancelLocked(job)
    job.active.notify(queue: control) { self.retire(id, job); completion() }
    lock.unlock()
  }
  private func submit(_ lease: String, _ id: String, read: Bool = false, short: Bool = false,
                      work: @escaping () -> [String: Any], completion: @escaping ([String: Any]) -> Void) {
    lock.lock()
    guard let job = jobs[id], job.lease == lease, !job.closing else {
      lock.unlock(); completion(["kind": "changed"]); return
    }
    let key = UUID(), operation = GuideWork(job: job, completion: completion)
    operations[key] = operation
    lock.unlock()
    let run = {
      self.lock.lock()
      guard self.operations[key] === operation, !job.closing else { self.lock.unlock(); return }
      operation.started = true; job.active.enter()
      self.lock.unlock()
      let result = work() // Core methods close files/statements before returning.
      self.lock.lock(); self.operations.removeValue(forKey: key); self.lock.unlock()
      job.active.leave()
      completion(result)
    }
    if read { reads.addOperation(run) }
    else if short { control.async(execute: run) }
    else { ingestQueue.async(execute: run) }
  }
  func attachAsync(_ id: String, _ revision: Int, completion: @escaping (Result<[String: Any], GuideFailure>) -> Void) {
    control.async {
      do { completion(.success(try self.attach(id, revision))) }
      catch let error as GuideFailure { completion(.failure(error)) }
      catch { completion(.failure(GuideFailure("disk"))) }
    }
  }
  func forgetAsync(_ id: String, completion: @escaping (Bool) -> Void) {
    lock.lock(); revoke(id)
    let affected = jobs.filter { $0.value.owner == id }
    let drained = DispatchGroup()
    for (key, _) in affected { drained.enter(); cancelAsync(key) { drained.leave() } }
    drained.notify(queue: control) { completion(self.forget(id)) }
    lock.unlock()
  }
  func restoreAsync(_ ids: [String], completion: @escaping ([[String: Any]]) -> Void) {
    lock.lock(); restoring = true
    let drained = DispatchGroup()
    for key in Array(jobs.keys) { drained.enter(); cancelAsync(key) { drained.leave() } }
    drained.notify(queue: control) {
      let restored = self.restore(ids)
      self.lock.lock(); self.restoring = false; self.lock.unlock()
      completion(restored)
    }
    lock.unlock()
  }
  func prepareAsync(_ lease: String, _ id: String, _ url: String, _ headers: [String: String], _ login: [String], _ now: Double, _ from: Double, _ until: Double, completion: @escaping ([String: Any]) -> Void) {
    submit(lease, id, work: { self.prepare(lease, id, url, headers, login, now, from, until) }, completion: completion)
  }
  func publishAsync(_ lease: String, _ id: String, _ candidate: String, completion: @escaping ([String: Any]) -> Void) {
    submit(lease, id, short: true, work: { self.publish(lease, id, candidate) }, completion: completion)
  }
  func queryAsync(_ lease: String, _ generation: String, _ id: String, _ ids: [String], _ at: Double, _ mode: String, _ from: Double, _ until: Double, _ after: Double, completion: @escaping ([String: Any]) -> Void) {
    submit(lease, id, read: true, work: { self.query(lease, generation, id, ids, at, mode, from, until, after) }, completion: completion)
  }
  private func context(_ lease: String, _ id: String) throws -> (String, GuideJob) {
    guard let owner = sources.first(where: { $0.value.lease == lease })?.key, let job = jobs[id], job.lease == lease else { throw GuideFailure("changed") }
    try job.check(); return (owner, job)
  }
  func prepare(_ lease: String, _ id: String, _ url: String, _ headers: [String: String], _ login: [String], _ now: Double, _ from: Double, _ until: Double) -> [String: Any] {
    guideResult {
      lock.lock(); let captured: (String, GuideJob)
      do { captured = try context(lease, id); captured.1.active.enter() } catch { lock.unlock(); throw error }; lock.unlock()
      let (owner, job) = captured
      defer { job.active.leave() }
      guard now.isFinite, from.isFinite, until.isFinite, from < now, until > now, until - from < 10 * 86400000 else { throw GuideFailure("time") }
      let dir = try directory(owner)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let key = UUID().uuidString
      let spool = dir.appendingPathComponent(key + ".spool")
      let closed = spool.appendingPathExtension("closed")
      let plain = dir.appendingPathComponent(key + ".xml")
      let part = try file(owner, key, part: true)
      defer { try? FileManager.default.removeItem(at: spool); try? FileManager.default.removeItem(at: closed); try? FileManager.default.removeItem(at: plain) }
      if let location = try GuideDownload(job: job, file: spool, disk: disk).run(url, headers) { return ["kind": "redirect", "location": location] }
      do {
        let handle = try FileHandle(forReadingFrom: closed); let magic = try handle.read(upToCount: 2); try handle.close()
        let xml: URL
        if magic == Data([31, 139]) {
          let inflateContext = GuideInflateContext(job: job)
          let result = mr_guide_inflate(closed.path, plain.path, UInt64(GuideBudget.plain), disk.raw, { context in
            guard let context = context else { return 1 }
            let state = Unmanaged<GuideInflateContext>.fromOpaque(context).takeUnretainedValue()
            do { try state.job.check(); return 0 } catch { return 1 }
          }, Unmanaged.passUnretained(inflateContext).toOpaque())
          try job.check(); try disk.check()
          if result != 0 { throw GuideFailure(result == 2 ? "body" : result == 4 ? "disk" : "gzip") }
          xml = plain
        } else { xml = closed }
        let last: Double = try {
          let index = try GuideIndex(part, job: job, disk: disk, create: true)
          try XmltvReader(index: index, job: job, disk: disk, login: login).run(xml)
          return try index.finish(now: now, from: from, until: until)
        }()
        let generation = GuideGeneration(id: key, fetchedAt: now, until: last)
        lock.lock(); defer { lock.unlock() }
        _ = try context(lease, id)
        candidates[key] = (owner, id, generation)
        return ["kind": "candidate", "id": key]
      } catch { try? FileManager.default.removeItem(at: part); try? FileManager.default.removeItem(at: URL(fileURLWithPath: part.path + "-journal")); throw error }
    }
  }
  func publish(_ lease: String, _ id: String, _ key: String) -> [String: Any] {
    guideResult {
      lock.lock(); defer { lock.unlock() }
      let (owner, job) = try context(lease, id)
      job.active.enter(); defer { job.active.leave() }
      guard let candidate = candidates[key], candidate.owner == owner, candidate.job == id else { throw GuideFailure("changed") }
      try job.check(); try disk.check()
      let source = try file(owner, key, part: true), destination = try file(owner, key)
      try FileManager.default.moveItem(at: source, to: destination)
      do { try disk.atomic(JSONEncoder().encode(candidate.generation), to: manifest(owner)) }
      catch { try? FileManager.default.removeItem(at: destination); throw error }
      sources[owner]?.generation = candidate.generation
      candidates.removeValue(forKey: key)
      prune(owner)
      return candidate.generation.payload
    }
  }
  func query(_ lease: String, _ generation: String, _ id: String, _ ids: [String], _ at: Double, _ mode: String, _ from: Double, _ until: Double, _ after: Double) -> [String: Any] {
    guideResult {
      lock.lock()
      let owner: String, job: GuideJob, path: URL
      do {
        (owner, job) = try context(lease, id)
        job.limit(seconds: 2) // Includes association selection and SQLite progress callbacks.
        guard sources[owner]?.generation?.id == generation else { throw GuideFailure("changed") }
        path = try file(owner, generation); pins[path, default: 0] += 1
        job.active.enter()
      } catch { lock.unlock(); throw error }
      lock.unlock()
      defer { lock.lock(); pins[path, default: 1] -= 1; if pins[path] == 0 { pins.removeValue(forKey: path) }; prune(owner); lock.unlock(); job.active.leave() }
      let result: [String: Any] = try {
        let index = try GuideIndex(path, job: job, disk: disk, create: false)
        return try index.query(ids: ids, at: at, mode: mode, from: from, until: until, after: after)
      }()
      lock.lock(); defer { lock.unlock() }; _ = try context(lease, id)
      return result
    }
  }
  func background() {
    lock.lock(); for key in Array(jobs.keys) { cancelAsync(key) {} }; lock.unlock()
  }
}
