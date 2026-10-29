import XCTest
@testable import GenesisKit

final class GenResizeTests: XCTestCase {
    /// The perf line names the steps, the gap percentiles and the late steps, so a laggy drag reads from the log alone.
    func testTheDragSummaryNamesStepsGapsAndLateSteps() {
        let gaps: [Double] = [8, 8, 9, 10, 12, 40, 90]
        let line = GenResizeDragTimer.summary("panel.hub.sidebar", from: 327, to: 412.6, gaps: gaps, seconds: 1.04)
        XCTAssertEqual(line, "resize panel.hub.sidebar 327->412 pt: 8 steps in 1.0 s, step gap p50 10 p95 90 max 90 ms, 2 over 33 ms")
    }

    /// Steps inside one bucket share a layout size, never smaller than the shown length, so the clip always has content.
    func testDragLayoutRoundsUpToWholeBuckets() {
        XCTAssertEqual(GenResizeLayout.bucketed(327.3), 336)
        XCTAssertEqual(GenResizeLayout.bucketed(330), 336)
        XCTAssertEqual(GenResizeLayout.bucketed(336), 336)
        XCTAssertEqual(GenResizeLayout.bucketed(0), 0)
        XCTAssertEqual(GenResizeLayout.bucketed(-4), 0)
    }

    func testOneStepHasNoGaps() {
        let line = GenResizeDragTimer.summary("prThreads.list", from: 260, to: 260, gaps: [], seconds: 0)
        XCTAssertEqual(line, "resize prThreads.list 260->260 pt: 1 steps in 0.0 s, step gap p50 0 p95 0 max 0 ms, 0 over 33 ms")
    }
}
