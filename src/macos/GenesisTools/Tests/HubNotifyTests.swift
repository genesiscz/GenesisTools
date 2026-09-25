import XCTest
@testable import GenesisTools

/// The PR notifications popover reads `tools hub notify status --json` and `poll --force --json`
/// (src/hub/lib/notify-poll.ts), and a banner click runs `open -n GenesisTools.app --args --hub --mode prs
/// [--pr <ref>]` (`openHubCommand`). The samples below were captured from the CLI under a scratch
/// GENESIS_TOOLS_HOME, with names and paths replaced by invented ones; the shapes are untouched.
final class HubNotifyTests: XCTestCase {
    /// A home with no notify.json, no state file and no daemon task.
    private let firstRunJSON = """
    {"config":{"enabled":true,"intervalMinutes":3,"onlyMine":false,"events":{"thread":true,"ciFailed":true,"ciPassed":false,"botReview":true,"merged":true},"repos":{},"botLogins":[]},"configPath":"/tmp/gt-home/.genesis-tools/hub/notify.json","statePath":"/tmp/gt-home/.genesis-tools/hub/notify-state.json","lastPollAt":null,"nextPollAt":null,"repos":{},"hosts":{},"recent":[],"requestsLastHour":0,"pollsLastHour":0,"daemonTask":false}
    """

    /// After polls: one repo fine, one failing and backing off, per-repo events, recent events.
    private let polledJSON = """
    {"config":{"enabled":true,"intervalMinutes":3,"onlyMine":false,"events":{"thread":false,"ciFailed":true,"ciPassed":false,"botReview":true,"merged":true},"repos":{"/tmp/gt/web":{"enabled":true,"events":{"ciPassed":true}},"/tmp/gt/shop":{"enabled":true},"/tmp/gt/old":{"enabled":false}},"botLogins":["reviewbot"]},
     "configPath":"/tmp/gt-home/.genesis-tools/hub/notify.json","statePath":"/tmp/gt-home/.genesis-tools/hub/notify-state.json",
     "lastPollAt":"2026-09-24T21:42:23.186Z","nextPollAt":"2026-09-24T21:45:23.186Z",
     "repos":{
       "github.com/acme/web":{"path":"/tmp/gt/web","failures":0,"nextAt":null,"lastOkAt":"2026-09-24T21:42:23.186Z","lastError":null,"lastMs":1158,"viewer":"alice"},
       "gitlab.example.invalid/group/shop":{"failures":2,"nextAt":"2026-09-24T21:49:13.685Z","lastOkAt":null,"lastError":"dial tcp: lookup gitlab.example.invalid: no such host.","lastMs":542,"path":"/tmp/gt/shop"}
     },
     "hosts":{"github.com":{"remaining":4670,"resetAt":"2026-09-24T21:43:47Z"}},
     "recent":[
       {"key":"github.com/acme/web#424","provider":"github","project":"acme/web","number":424,"url":"https://github.com/acme/web/pull/424","title":"Add the thing","type":"ciFailed","message":"CI failed on web#424 at f092d29","at":"2026-09-24T21:42:23.186Z","posted":true},
       {"key":"gitlab.example.invalid/group/shop#12","provider":"gitlab","project":"group/shop","number":12,"url":"https://gitlab.example.invalid/group/shop/-/merge_requests/12","title":"Fix the cart","type":"botReview","message":"reviewbot finished a review on shop!12","at":"2026-09-24T21:39:23.199Z","posted":false}
     ],
     "requestsLastHour":6,"pollsLastHour":6,"daemonTask":true}
    """

    func testFirstRunStatusDecodes() throws {
        let status = try HubNotifyStatus.decode(Data(firstRunJSON.utf8))
        XCTAssertNil(status.lastPollAt)
        XCTAssertEqual(status.daemonTask, false)
        XCTAssertTrue(status.config.repos.isEmpty)
        XCTAssertEqual(Set(status.config.events.keys), Set(HubNotifyEvent.allCases.map(\.rawValue)))
    }

    func testPolledStatusDecodesEveryField() throws {
        let status = try HubNotifyStatus.decode(Data(polledJSON.utf8))
        XCTAssertEqual(status.config.repos["/tmp/gt/web"]?.events?["ciPassed"], true)
        XCTAssertNil(status.config.repos["/tmp/gt/shop"]?.events)
        XCTAssertEqual(status.config.botLogins, ["reviewbot"])
        let failing = status.repos.values.first { $0.path == "/tmp/gt/shop" }
        XCTAssertEqual(failing?.failures, 2)
        XCTAssertNotNil(failing?.lastError)
        XCTAssertEqual(status.recent.map(\.ref), ["acme/web#424", "group/shop!12"])
        XCTAssertEqual(HubPRRef(status.recent[1].ref), HubPRRef(project: "group/shop", number: 12))
    }

    func testDaemonTaskUnknownIsNull() throws {
        let json = firstRunJSON.replacingOccurrences(of: "\"daemonTask\":false", with: "\"daemonTask\":null")
        XCTAssertNil(try HubNotifyStatus.decode(Data(json.utf8)).daemonTask)
    }

    func testPollReportSummaries() {
        let polled = """
        {"at":"2026-09-24T21:42:46.929Z","skipped":null,"dryRun":false,"repos":[{"key":"github.com/acme/web","path":"/tmp/gt/web","provider":"github","prs":11,"requests":1,"ms":860,"error":null,"skipped":null}],"items":[],"posted":0,"requests":1,"elapsedMs":871}
        """
        let notDue = """
        {"at":"2026-09-24T21:43:00.326Z","skipped":"not due: the last poll ran at 2026-09-24T21:42:59.184Z, every 3 min","dryRun":false,"repos":[],"items":[],"posted":0,"requests":0,"elapsedMs":2}
        """
        XCTAssertEqual(HubNotifyStore.pollSummary(Data(polled.utf8)), "Polled: 0 events, 0 posted, 1 requests")
        XCTAssertEqual(
            HubNotifyStore.pollSummary(Data(notDue.utf8)),
            "Poll skipped: not due: the last poll ran at 2026-09-24T21:42:59.184Z, every 3 min"
        )
    }

    /// The argv a banner click hands the hub (`openHubCommand` in notify-poll.ts, pinned by notify.test.ts).
    func testClickArgumentsOpenThePRsMode() {
        let github = HubRequest(["--mode", "prs", "--pr", "acme/web#7"])
        XCTAssertEqual(github.mode, .prs)
        XCTAssertEqual(github.pr, HubPRRef(project: "acme/web", number: 7))
        XCTAssertEqual(HubRequest(["--mode", "prs", "--pr", "group/sub/app!12"]).pr, HubPRRef(project: "group/sub/app", number: 12))
        XCTAssertEqual(HubRequest(["--mode", "prs", "--pr", "42"]).pr, HubPRRef(project: nil, number: 42))
        let noPR = HubRequest(["--mode", "prs"])
        XCTAssertEqual(noPR.mode, .prs)
        XCTAssertNil(noPR.pr)
    }
}
