import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// A hub `--snapshot` waits for the overlays it opened (the digest's day reading) on their load signal, and on expiry
/// captures anyway and names what was still loading.
@MainActor
final class HubSnapshotLoadsTests: XCTestCase {
    override func setUp() {
        HubSnapshotLoads.reset()
    }

    func testAnOpenedOverlayIsPendingUntilItsFirstLoadEnds() {
        XCTAssertEqual(HubSnapshotLoads.pending(expected: ["digest"]), ["digest"])
        let end = HubSnapshotLoads.begin("digest")
        XCTAssertEqual(HubSnapshotLoads.pending(expected: ["digest"]), ["digest"])
        end()
        end()
        XCTAssertEqual(HubSnapshotLoads.pending(expected: ["digest"]), [])
    }

    func testTheWaitWakesOnTheLoadsEndNotOnATimer() {
        let end = HubSnapshotLoads.begin("digest")
        var result: [String]?
        HubSnapshotLoads.whenIdle(expected: ["digest"], deadline: 30) { result = $0 }
        XCTAssertNil(result)
        end()
        XCTAssertEqual(result, [])
    }

    func testAStalledLoadIsNamedWhenTheDeadlinePasses() {
        _ = HubSnapshotLoads.begin("forecast")
        let named = expectation(description: "deadline")
        var result: [String]?
        HubSnapshotLoads.whenIdle(expected: ["digest"], deadline: 0.05) {
            result = $0
            named.fulfill()
        }
        wait(for: [named], timeout: 5)
        XCTAssertEqual(result, ["digest", "forecast"])
    }

    func testOnlyTheOverlaysARequestOpensAreExpected() {
        XCTAssertEqual(HubRequest(["--digest", "--snapshot", "/tmp/x.png"]).snapshotLoads, ["digest"])
        XCTAssertEqual(HubRequest(["--mode", "inbox", "--snapshot", "/tmp/x.png"]).snapshotLoads, [])
    }
}
