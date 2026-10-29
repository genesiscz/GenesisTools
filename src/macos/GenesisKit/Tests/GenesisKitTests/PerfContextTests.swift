import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// A stall line names the open screen and the steps before it.
final class PerfContextTests: XCTestCase {
    override func setUp() {
        PerfContext.resetForTesting()
    }

    func testDescribeNamesTheAreaAndTheNewestStepsFirst() {
        let start = CFAbsoluteTimeGetCurrent()
        PerfContext.area = "agents › main demo › transcript,changes"
        PerfContext.note("hub.transcript.page 120ms")
        PerfContext.note("hub.agents.list 40ms")

        let line = PerfContext.describe(now: start + 2)

        XCTAssertTrue(line.hasPrefix(" area=agents › main demo › transcript,changes recent=[hub.agents.list "), line)
        let newest = line.range(of: "hub.agents.list")!.lowerBound
        let older = line.range(of: "hub.transcript.page")!.lowerBound
        XCTAssertLessThan(newest, older, "the newest step comes first")
    }

    func testOnlyTheLastStepsAreKept() {
        for index in 0..<(PerfContext.keep + 3) {
            PerfContext.note("step\(index)")
        }

        let line = PerfContext.describe()

        XCTAssertFalse(line.contains("step0 "))
        XCTAssertTrue(line.contains("step\(PerfContext.keep + 2) "))
    }
}

/// The layout loop watch names a see-saw, never a drag.
final class LayoutLoopWatchTests: XCTestCase {
    func testADragThereAndBackIsNotALoop() {
        let drag = Array(300...340) + Array((280...339).reversed())
        XCTAssertEqual(LayoutLoopWatch.reversals(drag), 1)
        XCTAssertFalse(LayoutLoopWatch.isLoop(drag))
    }

    func testASeeSawOverThirtyWritesIsALoop() {
        let loop = (0..<40).map { $0 % 2 == 0 ? 302 : 308 }
        XCTAssertEqual(LayoutLoopWatch.reversals(loop), 38)
        XCTAssertTrue(LayoutLoopWatch.isLoop(loop))
        XCTAssertFalse(LayoutLoopWatch.isLoop(Array(loop.prefix(20))), "too few writes for a loop")
        XCTAssertEqual(LayoutLoopWatch.reversals([302, 302, 308, 308, 302]), 1, "a repeated value changes nothing")
    }
}
