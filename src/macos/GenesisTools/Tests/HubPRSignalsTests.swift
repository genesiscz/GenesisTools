import XCTest
@testable import GenesisTools

/// The PR detail's check logs (Hub/HubPRChecks.swift) and the notification settings
/// (Hub/HubNotify.swift) decode what `tools hub pr check-log --json` and `tools hub notify status --json` print.
final class HubPRSignalsTests: XCTestCase {
    func testACheckLogDecodesAndTintsItsFailureLines() throws {
        let json = """
        {"url":"https://github.com/acme/web/actions/runs/1/job/2","provider":"github",
         "sections":[{"name":"test / Run tests","url":null,"status":"failure","lines":["ok 1","FAIL a.test.ts","warning: slow"],"totalLines":40}],
         "errors":["Process completed with exit code 1."],"final":true,"cached":false,"fetchedAt":"","elapsedMs":12,"error":null}
        """
        let log = try JSONDecoder().decode(HubCheckLog.self, from: Data(json.utf8))
        XCTAssertEqual(log.sections.first?.totalLines, 40)
        XCTAssertTrue(log.plainText.hasPrefix("error: Process completed with exit code 1."))

        let render = CheckLogRender.build(log)
        let text = try XCTUnwrap(render.sections["test / Run tests"])
        XCTAssertEqual(String(text.characters), "ok 1\nFAIL a.test.ts\nwarning: slow")
        let tinted = text.runs.filter { $0.foregroundColor != nil }.map { String(text[$0.range].characters) }
        XCTAssertEqual(tinted, ["FAIL a.test.ts\n", "warning: slow"])
    }

    func testTheNotifyStatusDecodesWithItsRecentEvents() throws {
        let json = """
        {"config":{"enabled":true,"intervalMinutes":3,"onlyMine":false,
          "events":{"thread":true,"ciFailed":true,"ciPassed":false,"botReview":true,"merged":true},
          "repos":{"/work/web":{"enabled":true,"events":{"merged":false}}},"botLogins":[]},
         "configPath":"/tmp/notify.json","statePath":"/tmp/state.json","lastPollAt":null,"nextPollAt":null,
         "repos":{"github.com/acme/web":{"path":"/work/web","failures":2,"nextAt":"2026-01-02T10:06:00Z","lastOkAt":null,"lastError":"boom","lastMs":5}},
         "hosts":{},"recent":[{"type":"merged","key":"git.example.com/group/app#3","provider":"gitlab","project":"group/app","number":3,
           "url":"https://git.example.com/group/app/-/merge_requests/3","title":"Fix","message":"app!3 was merged","at":"2026-01-02T10:00:00Z","posted":true}],
         "requestsLastHour":20,"pollsLastHour":20,"daemonTask":false}
        """
        let status = try JSONDecoder().decode(HubNotifyStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.config.repos["/work/web"]?.events?["merged"], false)
        XCTAssertEqual(status.repos["github.com/acme/web"]?.path, "/work/web")
        XCTAssertEqual(status.recent.first?.ref, "group/app!3")
        XCTAssertEqual(HubPRRef(status.recent[0].ref), HubPRRef(project: "group/app", number: 3))
        XCTAssertEqual(status.daemonTask, false)
    }
}
