import XCTest
@testable import GenesisKit

/// Two measurements open at once each count only the bodies that ran inside their own window: starting
/// the second one does not take the first one's counts away.
final class RenderProbeTests: XCTestCase {
    private var wasEnabled = false

    override func setUp() {
        wasEnabled = RenderProbe.enabled
        RenderProbe.enabled = true
        _ = RenderProbe.take()
    }

    override func tearDown() {
        _ = RenderProbe.take()
        RenderProbe.enabled = wasEnabled
    }

    func testOverlappingWindowsKeepTheirOwnCounts() {
        RenderProbe.hit("before")
        let first = RenderProbe.snapshot()
        RenderProbe.hit("row.body")
        let second = RenderProbe.snapshot()
        RenderProbe.hit("row.body")
        RenderProbe.hit("codeBlock.body")

        XCTAssertEqual(RenderProbe.summary(since: second), " bodies[codeBlock.body=1 row.body=1]")
        XCTAssertEqual(RenderProbe.summary(since: first), " bodies[codeBlock.body=1 row.body=2]")
        XCTAssertEqual(RenderProbe.summary(since: RenderProbe.snapshot()), " bodies[none]")
    }

    func testASummaryIsEmptyWhileTheProbeIsOff() {
        let start = RenderProbe.snapshot()
        RenderProbe.hit("row.body")
        RenderProbe.enabled = false

        XCTAssertEqual(RenderProbe.summary(since: start), "")
    }
}
