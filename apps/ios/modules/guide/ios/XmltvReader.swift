import Foundation

/** XML declarations use XML S whitespace, including tabs and CR/LF. Validate the bounded
    declaration grammar before Foundation can select a non-UTF-8 decoder. */
private func guideUTF8Declaration(_ token: [UInt8]) -> Bool {
  guard token.count >= 8, token.suffix(2).elementsEqual([63, 62]) else { return false }
  let end = token.count - 2
  var position = 5, names = [String]()
  func spaces() -> Bool {
    let start = position
    while position < end && [UInt8(9), 10, 13, 32].contains(token[position]) { position += 1 }
    return position > start
  }
  guard spaces() else { return false }
  while position < end {
    let start = position
    while position < end && ((65...90).contains(token[position]) || (97...122).contains(token[position])) { position += 1 }
    let name = String(bytes: token[start..<position], encoding: .utf8) ?? ""
    guard ["version", "encoding", "standalone"].contains(name), !names.contains(name) else { return false }
    if names.isEmpty && name != "version" { return false }
    if name == "encoding" && names.contains("standalone") { return false }
    _ = spaces()
    guard position < end, token[position] == 61 else { return false }; position += 1
    _ = spaces()
    guard position < end, token[position] == 34 || token[position] == 39 else { return false }
    let quote = token[position]; position += 1
    let valueStart = position
    while position < end && token[position] != quote { position += 1 }
    guard position < end, let value = String(bytes: token[valueStart..<position], encoding: .utf8) else { return false }
    position += 1
    if name == "version" && value != "1.0" && value != "1.1" { return false }
    if name == "encoding" && value.lowercased() != "utf-8" { return false }
    if name == "standalone" && value != "yes" && value != "no" { return false }
    names.append(name)
    if position == end { return true }
    guard spaces() else { return false }
  }
  return !names.isEmpty
}

/** Accept only the external XMLTV header grammar. The declaration is blanked before XMLParser,
    so neither an external subset nor an entity can be resolved by the parser. */
private func guideExternalDoctype(_ token: [UInt8]) -> Bool {
  var position = 9 // <!DOCTYPE
  func spaces() -> Bool {
    let start = position
    while position < token.count && [UInt8(9), 10, 13, 32].contains(token[position]) { position += 1 }
    return position > start
  }
  func word() -> String {
    let start = position
    while position < token.count && ((65...90).contains(token[position]) || (97...122).contains(token[position])) { position += 1 }
    return String(bytes: token[start..<position], encoding: .utf8) ?? ""
  }
  func literal() -> Bool {
    guard position < token.count, token[position] == 34 || token[position] == 39 else { return false }
    let quote = token[position]; position += 1
    let start = position
    while position < token.count && token[position] != quote { position += 1 }
    guard position > start, position < token.count,
          String(bytes: token[start..<position], encoding: .utf8) != nil else { return false }
    position += 1
    return true
  }
  guard spaces(), word() == "tv", spaces() else { return false }
  let kind = word()
  guard kind == "SYSTEM" || kind == "PUBLIC", spaces(), literal() else { return false }
  if kind == "PUBLIC" && (!spaces() || !literal()) { return false }
  _ = spaces()
  return position == token.count - 1 && token[position] == 62
}

/** Bound raw allocations before XMLParser. Returns the one safe external declaration's byte range.
    Subsets, ENTITY, duplicate/late declarations and all other <! markup remain refused. */
func guidePreflight(_ file: URL, _ job: GuideJob) throws -> Range<Int>? {
  let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
  var token = [UInt8](); token.reserveCapacity(GuideBudget.token)
  var inTag = false, quote: UInt8 = 0
  var depth = 0, elementDepth = 0, elementBytes = 0, textBytes = 0
  var bytes = 0
  var sawTag = false
  var rootSeen = false
  var offset = 0, tokenStart = 0
  var external: Range<Int>?
  while let data = try handle.read(upToCount: 65536), !data.isEmpty {
    try job.check()
    bytes += data.count
    if bytes > GuideBudget.plain { throw GuideFailure("body") }
    for byte in data {
      defer { offset += 1 }
      if byte == 0 { throw GuideFailure("xml") } // UTF-16/32 cannot bypass the byte-level guards.
      if elementDepth > 0 {
        elementBytes += 1
        if elementBytes > GuideBudget.token { throw GuideFailure("element") }
      }
      if !inTag {
        if byte == 60 { inTag = true; sawTag = true; tokenStart = offset; token = [byte]; quote = 0; textBytes = 0 }
        else {
          if !sawTag && ![UInt8(9), 10, 13, 32, 239, 187, 191].contains(byte) { throw GuideFailure("xml") }
          textBytes += 1; if textBytes > GuideBudget.token { throw GuideFailure("element") }
        }
        continue
      }
      token.append(byte)
      if token.count > GuideBudget.token { throw GuideFailure("element") }
      let comment = token.starts(with: [60, 33, 45, 45])
      let cdata = token.starts(with: [60, 33, 91, 67, 68, 65, 84, 65, 91])
      let doctype = token.starts(with: [60, 33, 68, 79, 67, 84, 89, 80, 69])
      if token.count >= 9 && token[1] == 33 && !comment && !cdata && !doctype { throw GuideFailure("xml") }
      if comment {
        if !token.suffix(3).elementsEqual([45, 45, 62]) { continue }
      } else if cdata {
        if !token.suffix(3).elementsEqual([93, 93, 62]) { continue }
      } else {
        if quote != 0 { if byte == quote { quote = 0 }; continue }
        if byte == 34 || byte == 39 { quote = byte; continue }
        if byte != 62 { continue }
      }
      if token.starts(with: [60, 63, 120, 109, 108]), token.count > 5,
         [UInt8(9), 10, 13, 32].contains(token[5]), !guideUTF8Declaration(token) { throw GuideFailure("xml") }
      if doctype {
        guard !rootSeen, depth == 0, external == nil, guideExternalDoctype(token) else { throw GuideFailure("xml") }
        external = tokenStart..<(offset + 1)
      }
      if !comment && !cdata && !doctype && token.count > 2 && token[1] != 63 {
        if token[1] == 33 { throw GuideFailure("xml") }
        let closing = token[1] == 47
        let selfClosing = token.count >= 2 && token[token.count - 2] == 47
        if !closing && depth == 0 { rootSeen = true }
        let start = closing ? 2 : 1
        let name = String(bytes: token[start...].prefix { $0 != 32 && $0 != 9 && $0 != 10 && $0 != 13 && $0 != 47 && $0 != 62 }, encoding: .utf8) ?? ""
        if closing {
          if depth == elementDepth { elementDepth = 0 }
          depth -= 1
          if depth < 0 { throw GuideFailure("xml") }
        } else if !selfClosing {
          depth += 1
          if depth > 32 { throw GuideFailure("depth") }
          if elementDepth == 0 && (name == "programme" || name == "channel") { elementDepth = depth; elementBytes = token.count }
        }
      }
      inTag = false; token.removeAll(keepingCapacity: true)
    }
  }
  if inTag || depth != 0 { throw GuideFailure("xml") }
  return external
}

/** XMLTV timestamps are UTC without an offset. Calendar validation rejects normalized bad dates. */
func guideTime(_ raw: String?) -> Double? {
  guard let raw = raw else { return nil }
  let fields = raw.split(whereSeparator: { $0.isWhitespace })
  guard let first = fields.first else { return nil }
  let digits = Array(first.utf8)
  guard [8, 10, 12, 14].contains(digits.count), digits.allSatisfy({ (48...57).contains($0) }) else { return nil }
  func number(_ start: Int, _ count: Int, _ fallback: Int) -> Int {
    if digits.count < start + count { return fallback }
    return digits[start..<(start + count)].reduce(0) { $0 * 10 + Int($1 - 48) }
  }
  var offset = 0
  if fields.count > 2 { return nil }
  if fields.count == 2 {
    let zone = Array(fields[1].utf8)
    guard zone.count == 5, (zone[0] == 43 || zone[0] == 45), zone.dropFirst().allSatisfy({ (48...57).contains($0) }) else { return nil }
    let hours = Int(zone[1] - 48) * 10 + Int(zone[2] - 48), minutes = Int(zone[3] - 48) * 10 + Int(zone[4] - 48)
    guard hours <= 23 && minutes < 60 else { return nil }
    offset = (hours * 60 + minutes) * 60 * (zone[0] == 45 ? -1 : 1)
  }
  var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
  let components = DateComponents(year: number(0,4,0), month: number(4,2,1), day: number(6,2,1), hour: number(8,2,0), minute: number(10,2,0), second: number(12,2,0))
  guard let date = calendar.date(from: components), calendar.component(.year, from: date) == components.year, calendar.component(.month, from: date) == components.month, calendar.component(.day, from: date) == components.day, calendar.component(.hour, from: date) == components.hour, calendar.component(.minute, from: date) == components.minute, calendar.component(.second, from: date) == components.second else { return nil }
  return (date.timeIntervalSince1970 - Double(offset)) * 1000
}

final class XmltvReader: NSObject, XMLParserDelegate {
  private let index: GuideIndex
  private let job: GuideJob
  private let disk: GuideDisk
  private let password: String
  private var stack = [String]()
  private var channel: String?
  private var start: Double?
  private var stop: Double?
  private var title: String?
  private var descriptionText: String?
  private var text = ""
  private var rows = 0
  private var ids = Set<String>()
  private var opened = false
  private var closed = false
  private var failure: Error?
  init(index: GuideIndex, job: GuideJob, disk: GuideDisk, login: [String]) { self.index = index; self.job = job; self.disk = disk; password = login.count > 1 ? login[1] : "" }
  func run(_ file: URL) throws {
    if let external = try guidePreflight(file, job) {
      // Overwrite only the bounded declaration, without a second XML spool or growth.
      // XMLParser sees whitespace rather than a DTD, so the system identifier is never opened.
      let handle = try FileHandle(forUpdating: file)
      defer { try? handle.close() }
      try job.check(); try handle.seek(toOffset: UInt64(external.lowerBound))
      try disk.write(Data(repeating: 32, count: external.count), to: file, handle: handle)
    }
    try job.check()
    guard let stream = InputStream(url: file) else { throw GuideFailure("disk") }
    let parser = XMLParser(stream: stream); parser.delegate = self
    parser.shouldResolveExternalEntities = false
    let parsed = parser.parse()
    if let failure = failure { throw failure }
    try job.check()
    if !parsed || !opened || !closed { throw GuideFailure("xml") }
    if rows == 0 { throw GuideFailure("empty") }
  }
  private func checked(_ parser: XMLParser, _ work: () throws -> Void) {
    do { try job.check(); try work() } catch { failure = error; parser.abortParsing() }
  }
  func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String]) {
    checked(parser) {
      if stack.isEmpty {
        guard elementName == "tv", !opened else { throw GuideFailure("xml") }
        opened = true
      }
      if elementName == "programme" {
        rows += 1
        if rows > GuideBudget.rows { throw GuideFailure("rows") }
        guard stack == ["tv"] else { throw GuideFailure("xml") }
        channel = attributes["channel"]
        start = guideTime(attributes["start"]); stop = guideTime(attributes["stop"])
        title = nil; descriptionText = nil
      }
      if elementName == "channel" || elementName == "programme" {
        let id = attributes[elementName == "channel" ? "id" : "channel"] ?? ""
        if !id.isEmpty && id.unicodeScalars.count <= 128 {
          ids.insert(id)
          if ids.count > GuideBudget.channels { throw GuideFailure("rows") }
        }
      }
      stack.append(elementName); text = ""
    }
  }
  func parser(_ parser: XMLParser, foundCharacters string: String) {
    if text.utf8.count + string.utf8.count > GuideBudget.token { failure = GuideFailure("element"); parser.abortParsing(); return }
    text += string
  }
  func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
    guard let string = String(data: CDATABlock, encoding: .utf8) else { failure = GuideFailure("xml"); parser.abortParsing(); return }
    self.parser(parser, foundCharacters: string)
  }
  func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
    checked(parser) {
      let normalized = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
      if stack == ["tv", "programme", "title"], title == nil { title = String(String.UnicodeScalarView(normalized.unicodeScalars.prefix(300))) }
      if stack == ["tv", "programme", "desc"], descriptionText == nil { descriptionText = String(String.UnicodeScalarView(normalized.unicodeScalars.prefix(2000))) }
      if elementName == "programme", let id = channel, id.unicodeScalars.count <= 128, !id.isEmpty, let start = start, let title = title, !title.isEmpty, stop == nil || stop! - start >= 60000 {
        // Same prose policy as catalogue-cache holds(): raw password anywhere refuses persistence.
        // Username substrings in ordinary text are allowed. No artwork/URL fields are saved.
        let fields = [id, title, descriptionText ?? ""]
        if !password.isEmpty && fields.contains(where: { $0.contains(password) }) { throw GuideFailure("xml") }
        try index.insert(id, start, stop, title, descriptionText)
      }
      if stack == ["tv"] { closed = true }
      if !stack.isEmpty { stack.removeLast() }; text = ""
    }
  }
  func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? { failure = GuideFailure("xml"); parser.abortParsing(); return nil }
  func parser(_ parser: XMLParser, foundInternalEntityDeclarationWithName name: String, value: String?) { failure = GuideFailure("xml"); parser.abortParsing() }
  func parser(_ parser: XMLParser, foundExternalEntityDeclarationWithName name: String, publicID: String?, systemID: String?) { failure = GuideFailure("xml"); parser.abortParsing() }
}
