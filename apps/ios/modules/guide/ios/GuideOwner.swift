import Foundation

private final class GuideInflateContext {
  let job: GuideJob
  let root: URL
  init(job: GuideJob, root: URL) { self.job = job; self.root = root }
}

/** Native publication, lease revocation and read pins share one lock. IO work uses utility queues. */
final class GuideOwner {
  let root: URL
  private let lock = NSRecursiveLock()
  private var sources = [String: GuideActivation]()
  private var jobs = [String: GuideJob]()
  private var candidates = [String: (owner: String, job: String, generation: GuideGeneration)]()
  private var pins = [URL: Int]()
  private var blocked = Set<String>()
  let ingestQueue = DispatchQueue(label: "mrstreamer.guide.ingest", qos: .utility)
  let reads: OperationQueue = { let queue = OperationQueue(); queue.maxConcurrentOperationCount = 2; queue.qualityOfService = .utility; return queue }()
  init(root: URL) throws {
    self.root = root
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var excluded = root; var values = URLResourceValues(); values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }
  private func directory(_ id: String) throws -> URL {
    guard guideOpaque(id) else { throw GuideFailure("changed") }
    return root.appendingPathComponent(id, isDirectory: true)
  }
  private func manifest(_ id: String) throws -> URL { try directory(id).appendingPathComponent("manifest.json") }
  private func file(_ id: String, _ generation: String, part: Bool = false) throws -> URL {
    guard guideOpaque(generation) else { throw GuideFailure("changed") }
    return try directory(id).appendingPathComponent(generation + (part ? ".part" : ".sqlite"))
  }
  private func readGeneration(_ id: String) -> GuideGeneration? {
    do {
      let dir = try directory(id)
      if FileManager.default.fileExists(atPath: dir.appendingPathComponent("revoked").path) { return nil }
      let path = try manifest(id)
      let size = try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      if size > 1024 { return nil }
      let generation = try JSONDecoder().decode(GuideGeneration.self, from: Data(contentsOf: path))
      guard guideOpaque(generation.id), generation.fetchedAt.isFinite, generation.until.isFinite else { return nil }
      let db = try file(id, generation.id)
      let bytes = try db.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      if bytes <= 0 || bytes > GuideBudget.database { return nil }
      let index = try GuideIndex(db, job: GuideJob(UUID().uuidString, "restore"), root: root, create: false)
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
      for path in files where !allowed.contains(path.lastPathComponent) { try? FileManager.default.removeItem(at: path) }
    }
    var result = [[String: Any]]()
    for id in allowed {
      guard let dir = try? directory(id) else { continue }
      if FileManager.default.fileExists(atPath: dir.appendingPathComponent("revoked").path) {
        do { try FileManager.default.removeItem(at: dir); blocked.remove(id) } catch { blocked.insert(id); continue }
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
    if blocked.contains(id) || FileManager.default.fileExists(atPath: dir.appendingPathComponent("revoked").path) { throw GuideFailure("disk") }
    if let current = sources[id], current.revision == revision { return current.payload }
    if let current = sources[id] { for job in jobs.values where job.lease == current.lease { job.cancel() } }
    let activation = GuideActivation(lease: UUID().uuidString, revision: revision, generation: sources[id]?.generation ?? readGeneration(id))
    sources[id] = activation
    return activation.payload
  }
  func revoke(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    blocked.insert(id)
    if let source = sources.removeValue(forKey: id) { for job in jobs.values where job.lease == source.lease { job.cancel() } }
  }
  func forget(_ id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    revoke(id)
    do {
      let dir = try directory(id)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      // A failed deletion must never let restore or attach reopen this identity's old cache.
      try Data().write(to: dir.appendingPathComponent("revoked"), options: .atomic)
      if pins.keys.contains(where: { $0.deletingLastPathComponent() == dir }) { return false }
      try FileManager.default.removeItem(at: dir)
      blocked.remove(id)
      candidates = candidates.filter { $0.value.owner != id }
      return true
    } catch { return false }
  }
  func begin(_ lease: String, _ id: String) {
    lock.lock(); defer { lock.unlock() }
    guard guideOpaque(id), jobs[id] == nil, jobs.count < 128, sources.values.contains(where: { $0.lease == lease }) else { return }
    jobs[id] = GuideJob(id, lease)
  }
  func cancel(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    jobs[id]?.cancel()
  }
  func finish(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    jobs.removeValue(forKey: id)
    let dropped = candidates.filter { $0.value.job == id }
    for (key, value) in dropped { if let path = try? file(value.owner, key, part: true) { try? FileManager.default.removeItem(at: path) }; candidates.removeValue(forKey: key) }
  }
  private func context(_ lease: String, _ id: String) throws -> (String, GuideJob) {
    guard let owner = sources.first(where: { $0.value.lease == lease })?.key, let job = jobs[id], job.lease == lease else { throw GuideFailure("changed") }
    try job.check(); return (owner, job)
  }
  func prepare(_ lease: String, _ id: String, _ url: String, _ headers: [String: String], _ login: [String], _ now: Double, _ from: Double, _ until: Double) -> [String: Any] {
    guideResult {
      lock.lock(); let captured: (String, GuideJob)
      do { captured = try context(lease, id) } catch { lock.unlock(); throw error }; lock.unlock()
      let (owner, job) = captured
      guard now.isFinite, from.isFinite, until.isFinite, from < now, until > now, until - from < 10 * 86400000 else { throw GuideFailure("time") }
      let dir = try directory(owner)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let key = UUID().uuidString
      let spool = dir.appendingPathComponent(key + ".spool")
      let closed = spool.appendingPathExtension("closed")
      let plain = dir.appendingPathComponent(key + ".xml")
      let part = try file(owner, key, part: true)
      defer { try? FileManager.default.removeItem(at: spool); try? FileManager.default.removeItem(at: closed); try? FileManager.default.removeItem(at: plain) }
      if let location = try GuideDownload(job: job, file: spool, root: root).run(url, headers) { return ["kind": "redirect", "location": location] }
      do {
        let handle = try FileHandle(forReadingFrom: closed); let magic = try handle.read(upToCount: 2); try handle.close()
        let xml: URL
        if magic == Data([31, 139]) {
          let inflateContext = GuideInflateContext(job: job, root: root)
          let result = mr_guide_inflate(closed.path, plain.path, UInt64(GuideBudget.plain), { context in
            guard let context = context else { return 1 }
            let state = Unmanaged<GuideInflateContext>.fromOpaque(context).takeUnretainedValue()
            do { try state.job.check(); try guideDisk(state.root); return 0 } catch { return 1 }
          }, Unmanaged.passUnretained(inflateContext).toOpaque())
          try job.check(); try guideDisk(root)
          if result != 0 { throw GuideFailure(result == 2 ? "body" : result == 4 ? "disk" : "gzip") }
          xml = plain
        } else { xml = closed }
        let index = try GuideIndex(part, job: job, root: root, create: true)
        try XmltvReader(index: index, job: job, login: login).run(xml)
        let last = try index.finish(now: now, from: from, until: until)
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
      guard let candidate = candidates[key], candidate.owner == owner, candidate.job == id else { throw GuideFailure("changed") }
      try job.check(); try guideDisk(root)
      let source = try file(owner, key, part: true), destination = try file(owner, key)
      try FileManager.default.moveItem(at: source, to: destination)
      do { try JSONEncoder().encode(candidate.generation).write(to: manifest(owner), options: .atomic) }
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
        guard sources[owner]?.generation?.id == generation else { throw GuideFailure("changed") }
        path = try file(owner, generation); pins[path, default: 0] += 1
      } catch { lock.unlock(); throw error }
      lock.unlock()
      defer { lock.lock(); pins[path, default: 1] -= 1; if pins[path] == 0 { pins.removeValue(forKey: path) }; prune(owner); lock.unlock() }
      let index = try GuideIndex(path, job: job, root: root, create: false)
      let result = try index.query(ids: ids, at: at, mode: mode, from: from, until: until, after: after)
      lock.lock(); defer { lock.unlock() }; _ = try context(lease, id)
      return result
    }
  }
  func background() { lock.lock(); for job in jobs.values { job.cancel() }; lock.unlock() }
}
