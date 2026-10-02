import XCTest
@testable import GenesisKit

/// The session sidebar orders sub-agents working first, then idle, failed and done, newest started
/// first inside each.
final class SessionSubagentTests: XCTestCase {
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
