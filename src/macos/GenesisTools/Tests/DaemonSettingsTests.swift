import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub
@testable import GenesisToolsFeatures

/// Settings → Background → Daemon reads `tools daemon status --json`, `tools daemon stats --json` and
/// `tools daemon stats --view run --run <id> --json`. The samples are the CLI's shapes with invented task names.
final class DaemonSettingsTests: XCTestCase {
    private let statusJSON = """
    {"daemon":{"installed":true,"running":true,"pid":4242,"needsMigration":false,"foregroundPid":null},
     "configPath":"/tmp/gt-home/.genesis-tools/daemon/config.json","logsBaseDir":"/tmp/gt-home/.genesis-tools/daemon/logs",
     "tasks":[
      {"name":"nightly-scan","command":"true","every":"every day at 03:00","retries":1,"enabled":true,"timeoutMs":1800000,"notify":true,"priority":"low","missedRun":{"mode":"retry-at","times":["10:00","12:00"]},"schedule":"daily at 03:00","description":"Scan the work folders"},
      {"name":"poll","command":"true","every":"every 1 minute","retries":0,"enabled":false,"timeoutMs":60000,"notify":"failure","priority":"normal","missedRun":{"mode":"asap"},"schedule":"every 1m"},
      {"name":"quiet","command":"true","every":"every 15 minutes","retries":0,"enabled":true,"timeoutMs":10000,"notify":false,"priority":"high","missedRun":{"mode":"asap"},"schedule":"every 15m"}
     ]}
    """

    private let statsJSON = """
    {"version":1,"generatedAt":"2026-10-12T17:14:13.961Z","since":"2026-10-11T17:14:13.551Z","until":"2026-10-12T17:14:13.551Z","bucket":"hour","logsBaseDir":"/tmp/x",
     "totals":{"runs":10,"ok":8,"failed":1,"timedOut":1,"killed":0,"unfinished":0,"failureRate":0.2},
     "tasks":[{"task":"poll","configured":true,"enabled":false,"every":"every 1 minute","timeoutMs":60000,"runs":10,"ok":8,"failed":1,"timedOut":1,"killed":0,"unfinished":0,"failureRate":0.2,
       "p50Ms":13885,"p90Ms":56832,"p99Ms":66178,"maxMs":1196994,
       "histogram":[{"label":"<1s","minMs":0,"maxMs":1000,"count":1},{"label":"1-5s","minMs":1000,"maxMs":5000,"count":0}],
       "timeline":[],"failures":[],"lastFailure":null,
       "lastRun":{"task":"poll","runId":"2b13e0cc","attempt":1,"startedAt":"2026-10-12T17:13:49.281Z","status":"ok","exitCode":0,"durationMs":13535,"logFile":"/tmp/x/poll/a.jsonl","stderrTail":null,"reason":"manual"},
       "recentRuns":[{"task":"poll","runId":"2b13e0cc","attempt":1,"startedAt":"2026-10-12T17:13:49.281Z","status":"ok","exitCode":0,"durationMs":13535,"logFile":"/tmp/x/poll/a.jsonl","stderrTail":null,"reason":"manual"},
                     {"task":"poll","runId":"82b32913","attempt":2,"startedAt":"2026-10-12T14:43:49.283Z","status":"timedOut","exitCode":null,"durationMs":null,"logFile":"/tmp/x/poll/b.jsonl","stderrTail":["boom"],"reason":null}]}],
     "health":null}
    """

    @MainActor
    func testASnapshotOfTheDaemonPageWaitsForItsData() {
        let shell = FeatureSettingsShell(mode: .snapshot)
        XCTAssertTrue(shell.plugins.isEmpty)
        shell.shownPageID = DaemonSettingsPages.pageID
        XCTAssertFalse(shell.daemon.settled)
        XCTAssertFalse(shell.ready, "the Daemon page has no tasks yet")
        shell.daemon.message = "tools daemon status failed"
        XCTAssertTrue(shell.ready, "an error the page shows ends the wait")
    }

    @MainActor
    func testASnapshotOfAnotherPageDoesNotWaitForTheDaemon() {
        let shell = FeatureSettingsShell(mode: .snapshot)
        shell.shownPageID = "general"
        XCTAssertTrue(shell.ready)
    }

    @MainActor
    func testASnapshotOfThePRActivityPageWaitsForTheNotifyStatus() {
        let plugin = HubSettingsPlugin()
        let store = HubNotifyStore.shared
        defer { store.message = nil }
        XCTAssertTrue(plugin.settingsReady(page: "general"))
        XCTAssertEqual(plugin.settingsReady(page: PRActivitySettingsPages.pageID), store.settled)
        if store.status == nil {
            XCTAssertFalse(plugin.settingsReady(page: PRActivitySettingsPages.pageID), "no notify status yet")
            store.message = "tools hub notify status exited 1"
            XCTAssertTrue(plugin.settingsReady(page: PRActivitySettingsPages.pageID), "an error the page shows ends the wait")
        }
    }

    func testStatusDecodesEveryTaskSetting() throws {
        let status = try JSONDecoder().decode(DaemonStatusPayload.self, from: Data(statusJSON.utf8))
        XCTAssertEqual(status.daemon.pid, 4242)
        XCTAssertEqual(status.tasks.map(\.notify), ["on", "failure", "off"])
        XCTAssertEqual(status.tasks.map(\.priority), ["low", "normal", "high"])
        XCTAssertEqual(status.tasks[0].missedRun, .init(mode: "retry-at", times: ["10:00", "12:00"]))
        XCTAssertTrue(status.tasks[0].isTimeOfDay)
        XCTAssertFalse(status.tasks[1].isTimeOfDay)
        XCTAssertNil(status.tasks[1].description)
    }

    func testStatsAndRunsDecode() throws {
        let stats = try JSONDecoder().decode(DaemonStatsPayload.self, from: Data(statsJSON.utf8))
        let poll = try XCTUnwrap(stats.tasks.first)
        XCTAssertEqual(poll.recentRuns.map(\.status), ["ok", "timedOut"])
        XCTAssertEqual(poll.recentRuns[0].reason, "manual")
        XCTAssertNil(poll.recentRuns[1].durationMs)
        XCTAssertEqual(stats.totals.failureRate, 0.2)
        let output = try JSONDecoder().decode(
            DaemonRunOutput.self,
            from: Data(#"{"run":{"runId":"2b13e0cc"},"lines":[{"type":"meta","ts":"x"},{"type":"stdout","ts":"x","data":"done"}]}"#.utf8))
        XCTAssertEqual(output.lines.compactMap(\.data), ["done"])
    }

    /// The pane prints the numbers `tools daemon stats --view overview` prints (src/utils/format.ts, tiered).
    func testDurationsMatchTheOverview() {
        XCTAssertEqual(DaemonFormat.duration(500), "500ms")
        XCTAssertEqual(DaemonFormat.duration(13885), "13.9s")
        XCTAssertEqual(DaemonFormat.duration(56832), "56.8s")
        XCTAssertEqual(DaemonFormat.duration(1_196_994), "19m 56s")
        XCTAssertEqual(DaemonFormat.duration(1_259_000), "20m 59s")
        XCTAssertEqual(DaemonFormat.duration(3_700_000), "1h 1m")
        XCTAssertEqual(DaemonFormat.duration(nil), "—")
        XCTAssertEqual(DaemonFormat.percent(0.07445442875481387), "7.4%")
    }

    func testOptimisticCopyChangesOneField() throws {
        let status = try JSONDecoder().decode(DaemonStatusPayload.self, from: Data(statusJSON.utf8))
        let task = status.tasks[0]
        let changed = task.with(priority: "high")
        XCTAssertEqual(changed.priority, "high")
        XCTAssertEqual(changed.missedRun, task.missedRun)
        XCTAssertEqual(changed.enabled, task.enabled)
        XCTAssertEqual(changed.timeoutMs, task.timeoutMs)
    }
}
