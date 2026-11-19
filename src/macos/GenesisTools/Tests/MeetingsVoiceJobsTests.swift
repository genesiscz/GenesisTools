import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsVoiceJobsTests: XCTestCase {
    func testWindowHearsEachJobStateForItsMeetingWithoutReloadingTheOverview() throws {
        XCTAssertTrue(MeetingsAPI.windowEvents.contains("voices.job"))
        let decode = try XCTUnwrap(MeetingsAPI.eventDecoders["voices.job"])
        for state in ["queued", "running", "done", "cancelled", "failed"] {
            let event = try decode(["id": "job-a", "kind": "answer-samples", "project": "Orchard", "meeting": "one",
                                    "state": state, "progress": ["done": 1, "total": 2, "step": "Learning confirmed lines"],
                                    "added": 1, "skipped": 0] as [String: Any])
            XCTAssertEqual(event.meeting, "one")
            XCTAssertFalse(MeetingsWindowModel.changesOverview(event))
        }
    }
}
