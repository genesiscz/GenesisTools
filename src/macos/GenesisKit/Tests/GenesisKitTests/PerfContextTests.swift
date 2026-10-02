import XCTest
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
