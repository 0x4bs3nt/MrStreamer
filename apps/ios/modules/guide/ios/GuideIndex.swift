import Foundation
import SQLite3

private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
final class GuideIndex {
  private var db: OpaquePointer?
  private let job: GuideJob
  private let root: URL
  private var insertStatement: OpaquePointer?
  private var count = 0
  init(_ file: URL, job: GuideJob, root: URL, create: Bool) throws {
    self.job = job; self.root = root
    let flags = create ? SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE : SQLITE_OPEN_READONLY
    guard sqlite3_open_v2(file.path, &db, flags | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else { sqlite3_close(db); throw GuideFailure("disk") }
    sqlite3_progress_handler(db, 1000, { context in
      guard let context = context else { return 1 }
      let job = Unmanaged<GuideJob>.fromOpaque(context).takeUnretainedValue()
      return (try? job.check()) == nil ? 1 : 0
    }, Unmanaged.passUnretained(job).toOpaque())
    if create {
      try execute("PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA page_size=4096; PRAGMA max_page_count=8192; PRAGMA user_version=1; CREATE TABLE raw(channel TEXT NOT NULL,start REAL NOT NULL,stop REAL,title TEXT NOT NULL,description TEXT,PRIMARY KEY(channel,start)); BEGIN IMMEDIATE;")
      insertStatement = try prepare("INSERT OR IGNORE INTO raw VALUES(?,?,?,?,?)")
    } else {
      let schema = try prepare("PRAGMA user_version"); defer { sqlite3_finalize(schema) }
      if sqlite3_step(schema) != SQLITE_ROW || sqlite3_column_int(schema, 0) != 1 { throw GuideFailure("disk") }
    }
  }
  deinit { sqlite3_finalize(insertStatement); sqlite3_close(db) }
  private func prepare(_ sql: String) throws -> OpaquePointer {
    var statement: OpaquePointer?
    if sqlite3_prepare_v2(db, sql, -1, &statement, nil) != SQLITE_OK { throw GuideFailure("disk") }
    guard let statement = statement else { throw GuideFailure("disk") }; return statement
  }
  func execute(_ sql: String) throws {
    try job.check()
    if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK { try job.check(); throw GuideFailure("disk") }
  }
  private func bind(_ statement: OpaquePointer, _ position: Int32, _ value: String?) throws {
    let result: Int32
    if let value = value { result = sqlite3_bind_text(statement, position, value, -1, transient) }
    else { result = sqlite3_bind_null(statement, position) }
    if result != SQLITE_OK { throw GuideFailure("disk") }
  }
  func insert(_ channel: String, _ start: Double, _ stop: Double?, _ title: String, _ description: String?) throws {
    guard let statement = insertStatement else { throw GuideFailure("disk") }
    sqlite3_reset(statement); sqlite3_clear_bindings(statement)
    try bind(statement, 1, channel); sqlite3_bind_double(statement, 2, start)
    if let stop = stop { sqlite3_bind_double(statement, 3, stop) } else { sqlite3_bind_null(statement, 3) }
    try bind(statement, 4, title); try bind(statement, 5, description)
    if sqlite3_step(statement) != SQLITE_DONE { try job.check(); throw GuideFailure("disk") }
    count += 1
    if count % 512 == 0 { try job.check(); try execute("COMMIT; BEGIN IMMEDIATE;"); try guideDisk(root) }
  }
  func finish(now: Double, from: Double, until: Double) throws -> Double {
    sqlite3_finalize(insertStatement); insertStatement = nil
    // Sort inside SQLite. First duplicate start wins. Missing stops use next start; overlaps end there.
    try execute("COMMIT; CREATE TABLE programmes(channel TEXT NOT NULL,start REAL NOT NULL,stop REAL NOT NULL,title TEXT NOT NULL,description TEXT,PRIMARY KEY(channel,start));")
    let statement = try prepare("INSERT INTO programmes SELECT channel,start,finish,title,description FROM (SELECT *, CASE WHEN stop IS NULL THEN next WHEN next IS NULL THEN stop ELSE min(stop,next) END finish FROM (SELECT *,lead(start) OVER(PARTITION BY channel ORDER BY start) next FROM raw)) WHERE finish-start>=60000 AND finish>? AND start<?")
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_double(statement, 1, from); sqlite3_bind_double(statement, 2, until)
    if sqlite3_step(statement) != SQLITE_DONE { try job.check(); throw GuideFailure("disk") }
    let last: Double = try {
      let summary = try prepare("SELECT count(*),count(DISTINCT channel),max(stop) FROM programmes")
      defer { sqlite3_finalize(summary) }
      if sqlite3_step(summary) != SQLITE_ROW { throw GuideFailure("disk") }
      if sqlite3_column_int(summary, 0) == 0 { throw GuideFailure(count == 0 ? "empty" : "ended") }
      if sqlite3_column_int(summary, 1) > GuideBudget.channels { throw GuideFailure("rows") }
      let last = sqlite3_column_double(summary, 2)
      if last <= now { throw GuideFailure("ended") }
      return last
    }()
    try execute("DROP TABLE raw; VACUUM; PRAGMA quick_check;")
    try guideDisk(root)
    return last
  }
  func integrity() throws {
    let statement = try prepare("PRAGMA quick_check"); defer { sqlite3_finalize(statement) }
    guard sqlite3_step(statement) == SQLITE_ROW, let value = sqlite3_column_text(statement, 0), String(cString: value) == "ok" else { throw GuideFailure("disk") }
  }
  func query(ids: [String], at: Double, mode: String, from: Double, until: Double, after: Double) throws -> [String: Any] {
    let started = ProcessInfo.processInfo.systemUptime
    guard ids.count <= 128, ids.allSatisfy({ $0.utf8.count <= 512 }), ["listing", "day", "detail"].contains(mode), at.isFinite, from.isFinite, until.isFinite, after.isFinite else { throw GuideFailure("reply") }
    var selected: String?
    for id in ids {
      let test = try prepare("SELECT 1 FROM programmes WHERE channel=? AND stop>? LIMIT 1")
      try bind(test, 1, id); sqlite3_bind_double(test, 2, at)
      let found = sqlite3_step(test) == SQLITE_ROW; sqlite3_finalize(test)
      if found { selected = id; break }
    }
    guard let selected = selected else { return ["guideId": NSNull(), "rows": [], "more": false] }
    let sql: String
    switch mode {
    case "listing": sql = "SELECT start,stop,title,description FROM programmes WHERE channel=? AND stop>? ORDER BY start LIMIT 2"
    case "detail": sql = "SELECT start,stop,title,description FROM programmes WHERE channel=? AND start=? LIMIT 1"
    default:
      if until <= from || until - from > 26 * 3600000 { throw GuideFailure("time") }
      sql = "SELECT start,stop,title,NULL FROM programmes WHERE channel=? AND stop>? AND start<? AND start>? ORDER BY start LIMIT 129"
    }
    let statement = try prepare(sql); defer { sqlite3_finalize(statement) }
    try bind(statement, 1, selected)
    sqlite3_bind_double(statement, 2, mode == "listing" ? at : mode == "detail" ? after : from)
    if mode == "day" { sqlite3_bind_double(statement, 3, until); sqlite3_bind_double(statement, 4, after) }
    var rows = [[String: Any]]()
    var more = false
    while true {
      try job.check()
      if ProcessInfo.processInfo.systemUptime - started > 2 { throw GuideFailure("time") }
      let code = sqlite3_step(statement)
      if code == SQLITE_DONE { break }
      if code != SQLITE_ROW { try job.check(); throw GuideFailure("disk") }
      if rows.count == 128 { more = true; break }
      guard let title = sqlite3_column_text(statement, 2) else { throw GuideFailure("disk") }
      let description = sqlite3_column_text(statement, 3).map { String(cString: $0) }
      rows.append(["start": sqlite3_column_double(statement, 0), "stop": sqlite3_column_double(statement, 1), "title": String(cString: title), "description": description as Any? ?? NSNull()])
    }
    let result: [String: Any] = ["guideId": selected, "rows": rows, "more": more]
    if try JSONSerialization.data(withJSONObject: result).count > 1024 * 1024 { throw GuideFailure("reply") }
    return result
  }
}
