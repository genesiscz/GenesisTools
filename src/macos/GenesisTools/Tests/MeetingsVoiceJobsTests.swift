import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsVoiceJobsTests: XCTestCase {
    func testReconnectListsMissedJobsAndCancelUsesTheJobID() async throws {
        let fake = try FakeMeetingsService()
        func payload(_ state: String, _ step: String) -> [String: Any] {
            ["id": "job-one", "kind": "answer-samples", "project": "Orchard", "meeting": "one",
             "state": state, "progress": ["done": 1, "total": 2, "step": step], "added": 0, "skipped": 1]
        }
        let queued = payload("queued", "Learning confirmed lines")
        let running = payload("running", "Recording changed")
        let cancelled = payload("cancelled", "Recording changed")
        let done = payload("done", "1 × recording changed")
        fake.fixtureMethods = ["voices.list", "voices.jobs", "voices.jobs.cancel"]
        fake.answers["subscribe"] = ["result": ["events": MeetingsAPI.windowEvents]]
        fake.fixtureReply = { [weak fake] method, _ in
            if method == "voices.list" { return ["people": []] }
            if method == "voices.jobs.cancel" { return cancelled }
            return [fake?.count("voices.jobs") == 1 ? queued : done]
        }
        try await fake.withVoiceWindow { window in
            let model = window.voiceLibrary
            model.show(.inspector(meeting: "one", project: "Orchard", meetingOnly: true), doubtfulFirst: true)
            let listed = await waitUntil(3) { model.jobs.first?.state == .queued }
            XCTAssertTrue(listed)
            window.startLiveUpdates()
            defer { window.detachLiveUpdates() }
            let subscribed = await waitUntil(3) { window.service?.isSubscribed == true }
            XCTAssertTrue(subscribed)
            fake.send(["jsonrpc": "2.0", "method": "voices.job", "params": running])
            let heard = await waitUntil(3) { model.jobs.first?.state == .running }
            XCTAssertTrue(heard)
            let job = try XCTUnwrap(model.jobs.first)
            XCTAssertEqual(job.state, .running)
            XCTAssertEqual(job.skipped, 1)
            model.cancel(job)
            let stopped = await waitUntil(3) { model.jobs.first?.state == .cancelled }
            XCTAssertTrue(stopped)
            let params = fake.received.first { $0["method"] as? String == "voices.jobs.cancel" }?["params"] as? [String: String]
            XCTAssertEqual(params, ["id": "job-one"])
            fake.hangUp()
            let resumed = await waitUntil(5) { model.jobs.first?.state == .done }
            XCTAssertTrue(resumed)
            XCTAssertEqual(model.jobs.first?.progress.step, "1 × recording changed")
            XCTAssertEqual(fake.count("voices.jobs"), 2)
            XCTAssertEqual(fake.count("subscribe"), 2)
        }
    }

    func testTheHistoryCapAppliesAfterMeetingMembershipArrives() async throws {
        let fake = try FakeMeetingsService()
        fake.fixtureMethods = ["voices.list"]
        fake.fixtureReply = { _, _ in ["people": []] }
        try await fake.withVoiceWindow { window in
            let model = window.voiceLibrary
            let owner = VoiceOwner(name: "Aster")
            let jobs = (0...50).map { index in
                ["id": "job-\(index)", "kind": "answer-samples", "project": "Orchard",
                 "meeting": "practice-\(index)", "state": "done",
                 "progress": ["done": 1, "total": 1, "step": "Learned"], "added": 0, "skipped": 1] as [String: Any]
            }
            model.snapshotJobs = try MeetingsService.decode(MeetingsAPI.VoicesJobs.Result.self, jobs)
            model.show(.person(owner, project: nil), doubtfulFirst: false)
            XCTAssertEqual(model.jobs.map(\.id), [])
            model.rememberMeetings(try MeetingsService.decode(MeetingsAPI.PeopleMeetings.Result.self, [
                "person": ["id": "name:aster", "name": "Aster", "rank": "meetings", "sources": ["meetings"]],
                "meetings": [["meeting": "practice-0", "title": "Practice", "start": "2026-01-12T10:00:00Z",
                              "as": ["participant"], "present": [], "labels": []]],
            ] as [String: Any]))
            XCTAssertEqual(model.jobs.map(\.id), ["job-0"])
        }
    }

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
