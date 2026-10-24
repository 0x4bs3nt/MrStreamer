import AVFoundation
import XCTest
@testable import ExpoVideo

/// Real source loads are held through expo-video's existing production transport boundary.
private actor HeldPreparation {
  private var waiting: CheckedContinuation<Void, Never>?
  private var entered = false
  private var enteredWaiters: [CheckedContinuation<Void, Never>] = []

  func hold() async {
    entered = true
    enteredWaiters.forEach { $0.resume() }
    enteredWaiters.removeAll()
    await withCheckedContinuation { waiting = $0 }
  }
  func waitUntilEntered() async {
    if entered { return }
    await withCheckedContinuation { enteredWaiters.append($0) }
  }
  func release() { waiting?.resume(); waiting = nil }
}

private final class HeldTransport: VideoAssetTransportProvider {
  let identifier = "mrstreamer-native-r24-held"
  let priority = Int.max
  let gate: HeldPreparation
  init(_ gate: HeldPreparation) { self.gate = gate }
  func makeLoadPlan(for source: VideoAssetSourceDescriptor) -> VideoAssetLoadPlan? {
    guard source.url.scheme == "mr-r24" else { return nil }
    return VideoAssetLoadPlan(
      assetURL: URL(fileURLWithPath: "/dev/null"),
      prepareAsset: { [gate] _ in await gate.hold() }
    )
  }
}

@MainActor
final class ObservedPlayerContractTests: XCTestCase {
  private func player() throws -> VideoPlayer {
    try VideoPlayer(AVPlayer(), initialSource: nil, useSynchronousReplace: true)
  }
  private func source(_ ordinal: Int) -> VideoSource {
    var source = VideoSource()
    source.uri = URL(string: "mr-r24://fixture/\(ordinal)")!
    return source
  }

  func testCancelBeforeAdmissionDoesNotConstructAnItem() async throws {
    let player = try player()
    let receipt = try await player.detachObserved(attemptId: 1)
    XCTAssertEqual(receipt["kind"] as? String, "detached")
    XCTAssertTrue(receipt["itemId"] is NSNull)
    let result = try await player.replaceObserved(source: source(1), attemptId: 1)
    XCTAssertEqual(result["kind"] as? String, "cancelled")
    XCTAssertNil(player.ref.currentItem)
    player.sharedObjectWillRelease()
  }

  func testHeldLoadRetainsClosingUntilRealSettlementAndCannotAttachOverB() async throws {
    let gate = HeldPreparation()
    VideoAssetTransportRegistry.registerProvider(HeldTransport(gate))
    defer { VideoAssetTransportRegistry.unregisterProvider(withId: "mrstreamer-native-r24-held") }
    let player = try player()
    let openingA = Task { try await player.replaceObserved(source: source(1), attemptId: 1) }
    await gate.waitUntilEntered()
    let closeA = Task { try await player.detachObserved(attemptId: 1) }
    let duplicate = Task { try await player.detachObserved(attemptId: 1) }
    await Task.yield()
    do {
      _ = try await player.replaceObserved(source: source(2), attemptId: 2)
      XCTFail("A held load must block B admission even after local item exclusion")
    } catch {
      XCTAssertEqual((error as? ObservedPlaybackException)?.code, "ERR_OBSERVED_NOT_DRAINED")
    }
    XCTAssertNil(player.ref.currentItem)
    await gate.release()
    let resultA = try await openingA.value
    XCTAssertEqual(resultA["kind"] as? String, "cancelled")
    let first = try await closeA.value
    let second = try await duplicate.value
    XCTAssertTrue(NSDictionary(dictionary: first).isEqual(to: second))
    XCTAssertEqual(first["providerDisconnect"] as? String, "unobservable")
    XCTAssertEqual(first["appWorkDrained"] as? Bool, true)
    XCTAssertNil(player.ref.currentItem)
    // A second real native item may attach only after the old load's continuation returned.
    VideoAssetTransportRegistry.unregisterProvider(withId: "mrstreamer-native-r24-held")
    var local = VideoSource()
    local.uri = URL(fileURLWithPath: "/dev/null")
    let resultB = try await player.replaceObserved(source: local, attemptId: 2)
    XCTAssertEqual(resultB["kind"] as? String, "attached")
    let itemB = player.ref.currentItem
    let repeatedOld = try await player.detachObserved(attemptId: 1)
    XCTAssertTrue(NSDictionary(dictionary: repeatedOld).isEqual(to: first))
    XCTAssertTrue(player.ref.currentItem === itemB)
    _ = try await player.detachObserved(attemptId: 2)
    player.sharedObjectWillRelease()
  }

  func testUnsafeAttemptIdsAndLegacyWritersFailWithFixedCodes() async throws {
    let player = try player()
    for id in [Double.nan, .infinity, -1, 0, 1.5, 9_007_199_254_740_992] {
      do {
        _ = try await player.replaceObserved(source: source(1), attemptId: id)
        XCTFail("Invalid attempt admitted")
      } catch {
        XCTAssertEqual((error as? ObservedPlaybackException)?.code, "ERR_OBSERVED_ATTEMPT_ID")
      }
    }
    var local = VideoSource()
    local.uri = URL(fileURLWithPath: "/dev/null")
    _ = try await player.replaceObserved(source: local, attemptId: 1)
    XCTAssertThrowsError(try player.requireLegacyPlayback()) { error in
      XCTAssertEqual((error as? ObservedPlaybackException)?.code, "ERR_OBSERVED_LEGACY_WRITE")
    }
    _ = try await player.detachObserved(attemptId: 1)
    player.sharedObjectWillRelease()
  }

  func testStaleTrackQueryAndSelectionCannotChangeNewItem() async throws {
    let player = try player()
    var local = VideoSource()
    local.uri = URL(fileURLWithPath: "/dev/null")
    let a = try await player.replaceObserved(source: local, attemptId: 1)
    var expected = ObservedItemIdentity()
    expected.attemptId = 1
    expected.itemId = a["itemId"] as! Double
    let reading = Task { await player.getObservedTracks(expected) }
    _ = try await player.detachObserved(attemptId: 1)
    _ = await reading.value
    _ = try await player.replaceObserved(source: local, attemptId: 2)
    let itemB = player.ref.currentItem
    let staleQuery = await player.getObservedTracks(expected)
    let staleChoice = await player.selectObservedTrack(expected, revision: 0,
      selection: ["kind": "subtitles", "track": NSNull()])
    XCTAssertEqual(staleQuery["kind"] as? String, "stale")
    XCTAssertEqual(staleChoice["kind"] as? String, "stale")
    XCTAssertTrue(player.ref.currentItem === itemB)
    _ = try await player.detachObserved(attemptId: 2)
    player.sharedObjectWillRelease()
  }
}
