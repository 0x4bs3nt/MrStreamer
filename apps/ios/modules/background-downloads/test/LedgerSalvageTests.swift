import XCTest

@testable import BackgroundDownloads

/**
 A damaged queue-v2.json read field by field and entry by entry: a field of the wrong shape, or a
 bad entry, never hides an independently readable receipt, and what is salvaged is never
 authority. Unrun until a disposable XCTest target links this module (README.md).
 */
final class LedgerSalvageTests: XCTestCase {
  private let file = LedgerFile()
  private var url: URL { file.folder!.appendingPathComponent("queue-v2.json") }

  private let complete = #"""
    {"version":2,"receipt":"r-kept","authorization":"z-1","attempt":"a-1","id":"d-1",
     "sequence":3,"received":10,"expected":10,"restarted":false,
     "outcome":{"kind":"complete","size":10,"expected":10}}
    """#
  private let legacyComplete = #"""
    {"receipt":"r-build14","attempt":"a-14","id":"d-2","outcome":{"kind":"complete","size":5}}
    """#

  override func setUpWithError() throws {
    try FileManager.default.createDirectory(at: file.folder!, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: url)
  }

  private func salvage(_ json: String) throws -> Salvage {
    try Data(json.utf8).write(to: url)
    guard case .corrupt(let salvage) = file.read() else {
      XCTFail("A damaged queue read as authority")
      throw CocoaError(.fileReadCorruptFile)
    }
    return salvage
  }

  private func queue(sources: String, authorizations: String, receipts: String, legacy: String)
    -> String
  {
    #"{"version":2,"install":"q-1","sequence":3,"nextOrder":1,"sources":\#(sources),"#
      + #""authorizations":\#(authorizations),"receipts":\#(receipts),"legacy":\#(legacy)}"#
  }

  func testWrongTypedSourcesKeepsEveryReceipt() throws {
    let found = try salvage(
      queue(
        sources: "[]", authorizations: "{}", receipts: "[\(complete)]",
        legacy: #"{"attempts":{},"receipts":[\#(legacyComplete)]}"#))
    XCTAssertEqual(found.receipts.map(\.receipt), ["r-kept"])
    XCTAssertEqual(found.legacy.map(\.receipt), ["r-build14"])
    XCTAssertTrue(found.unreadable)
  }

  func testWrongTypedAuthorizationsKeepsReceiptsAndNamedSources() throws {
    let found = try salvage(
      queue(
        sources: #"{"xtream-1":{"generation":"g-1","state":"enabled"}}"#, authorizations: "7",
        receipts: "[\(complete)]", legacy: #"{"attempts":{},"receipts":[]}"#))
    XCTAssertEqual(found.receipts.map(\.receipt), ["r-kept"])
    XCTAssertEqual(found.sources, ["xtream-1"])
    XCTAssertTrue(found.unreadable)
  }

  func testMalformedLegacyAttemptsKeepBuild14Receipts() throws {
    let found = try salvage(
      queue(
        sources: "{}", authorizations: #"{"z-1":{"id":5}}"#, receipts: "[\(complete)]",
        legacy: #"{"attempts":{"a-14":"not an attempt"},"receipts":[\#(legacyComplete)]}"#))
    XCTAssertEqual(found.receipts.map(\.receipt), ["r-kept"])
    XCTAssertEqual(found.legacy.map(\.receipt), ["r-build14"])
    XCTAssertTrue(found.unreadable)
  }

  func testOneBadReceiptHidesNoOther() throws {
    let found = try salvage(
      queue(
        sources: "{}", authorizations: "{}", receipts: #"[{"receipt":1},\#(complete)]"#,
        legacy: #"{"attempts":{},"receipts":[]}"#))
    XCTAssertEqual(found.receipts.map(\.receipt), ["r-kept"])
    XCTAssertTrue(found.unreadable)
  }

  func testAMissingReceiptsFieldIsUnreadableNotEmpty() throws {
    let found = try salvage(#"{"version":2,"install":"q-1","sources":{}}"#)
    XCTAssertEqual(found.receipts.count, 0)
    XCTAssertTrue(found.unreadable)
  }
}
