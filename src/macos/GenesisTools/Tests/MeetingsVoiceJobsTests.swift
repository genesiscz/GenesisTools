import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsVoiceJobsTests: XCTestCase {
    func testListingAndCancellationDecodeTheServiceResponseDirectly() throws {
        let object: [String: Any] = ["id": "j", "kind": "answer-samples", "project": "Orchard", "state": "running",
                                     "progress": ["done": 0, "total": 0, "step": "Naming again with 2 new samples"],
                                     "added": 0, "skipped": 0]
        let jobs = try MeetingsService.decode(MeetingsAPI.VoicesJobs.Result.self, [object])
        XCTAssertEqual(jobs.first?.progress.step, "Naming again with 2 new samples")
        XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.VoicesJobsCancel.Result.self, object), jobs.first)
        XCTAssertNil(try MeetingsService.decode(MeetingsAPI.VoicesJobsCancel.Result.self, NSNull()))
    }

    func testWindowHearsEachJobStateForItsMeetingWithoutReloadingTheOverview() throws {
        XCTAssertTrue(MeetingsAPI.windowEvents.contains("voices.job"))
        let decode = try XCTUnwrap(MeetingsAPI.eventDecoders["voices.job"])
        for state in ["queued", "running", "done", "cancelled", "failed"] {
            let event = try decode(["id": "job-a", "kind": "answer-samples", "project": "Orchard", "meeting": "one",
                                    "state": state, "progress": ["done": 1, "total": 2, "step": "Learning confirmed lines"],
                                    "added": 1, "skipped": 0] as [String: Any])
            guard case .voiceJob(let job) = event else { return XCTFail("expected a voice job") }
            XCTAssertEqual(job.canCancel, ["queued", "running"].contains(state))
            XCTAssertTrue(job.matches(.person(.init(name: "Aster"), project: nil), meetings: ["one"]))
            XCTAssertFalse(job.matches(.person(.init(name: "Aster"), project: nil), meetings: ["two"]))
            XCTAssertFalse(job.matches(.project("Elsewhere"), meetings: []))
            XCTAssertFalse(job.matches(.inspector(meeting: "two", project: "Orchard", meetingOnly: false), meetings: []))
            XCTAssertEqual(event.meeting, "one")
            XCTAssertFalse(MeetingsWindowModel.changesOverview(event))
        }
    }
}
