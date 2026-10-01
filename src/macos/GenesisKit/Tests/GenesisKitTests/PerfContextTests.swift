import XCTest
@testable import GenesisKit

/// A stall line names the open screen and the steps before it; the session sidebar orders sub-agents
/// working first, then idle, failed and done, newest started first inside each.
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

    func testSubagentsOrderWorkingIdleFailedThenDoneNewestFirst() {
        let base = Date(timeIntervalSince1970: 1_000)
        func agent(_ id: String, _ state: SessionSubagent.State, _ minute: Double?) -> SessionSubagent {
            SessionSubagent(id: id, kind: "Agent", summary: id, state: state, startedAt: minute.map { base.addingTimeInterval($0 * 60) })
        }
        let agents = [
            agent("done-old", .done, 1),
            agent("run-old", .running, 2),
            agent("idle", .idle, 3),
            agent("done-new", .done, 9),
            agent("run-new", .running, 8),
            agent("failed", .failed, 4),
            agent("done-undated", .done, nil),
        ]

        XCTAssertEqual(
            SessionSubagent.ordered(agents).map(\.id),
            ["run-new", "run-old", "idle", "failed", "done-new", "done-old", "done-undated"]
        )
    }
}
