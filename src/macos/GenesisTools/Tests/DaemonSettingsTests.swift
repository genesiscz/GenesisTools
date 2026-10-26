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
    func testASnapshotWithoutAPageWaitsForTheSavedPage() {
        let key = "featureSettings.selectedPage"
        let previous = UserDefaults.standard.object(forKey: key)
        UserDefaults.standard.set(DaemonSettingsPages.pageID, forKey: key)
        defer { UserDefaults.standard.set(previous, forKey: key) }
        let shell = FeatureSettingsShell(mode: .snapshot)
        _ = shell.prepareForSnapshot(pageID: nil)
        XCTAssertEqual(shell.shownPageID, DaemonSettingsPages.pageID)
        XCTAssertFalse(shell.ready, "the saved page is the Daemon page, and it has no tasks yet")
    }

    @MainActor
    func testASnapshotOfAnotherPageDoesNotWaitForTheDaemon() {
        let shell = FeatureSettingsShell(mode: .snapshot)
        shell.shownPageID = "general"
        XCTAssertTrue(shell.ready)
    }

    @MainActor
    func testASnapshotOfThePRActivityPageWaitsForTheNotifyStatus() {
        let store = HubNotifyStore()
        let plugin = HubSettingsPlugin(notify: store)
        XCTAssertTrue(plugin.settingsReady(page: "general"))
        XCTAssertFalse(plugin.settingsReady(page: PRActivitySettingsPages.pageID), "no notify status yet")
        store.message = HubNotifyNotice(text: "The notification settings could not be read.", tone: .error,
                                        more: "tools hub notify status exited 1")
        XCTAssertTrue(plugin.settingsReady(page: PRActivitySettingsPages.pageID), "an error the page shows ends the wait")
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

    func testDelayedRetryAcknowledgementPreservesNewerTypingAndSubmissions() {
        var draft = "11:00"
        var submitted = draft
        draft = "13:00"
        draft = DaemonRetryTimeDraft.reconciled(draft, old: "10:00", stored: "11:00",
                                               submitted: submitted, isFocused: true)
        XCTAssertEqual(draft, "13:00", "the delayed 11:00 save must not replace newer unsaved text")

        submitted = draft
        draft = DaemonRetryTimeDraft.reconciled(draft, old: "10:00", stored: "11:00",
                                               submitted: submitted, isFocused: true)
        XCTAssertEqual(draft, "13:00", "an earlier response must not acknowledge the newer submitted value")
        XCTAssertFalse(DaemonRetryTimeDraft.acknowledges("11:00", submitted: submitted))
        XCTAssertTrue(DaemonRetryTimeDraft.acknowledges("13:00", submitted: submitted))
        XCTAssertEqual(DaemonRetryTimeDraft.reconciled("11:00,13:00", old: "10:00", stored: "11:00, 13:00",
                                                      submitted: "11:00,13:00", isFocused: true), "11:00, 13:00")
        XCTAssertEqual(DaemonRetryTimeDraft.reconciled("11:00", old: "10:00", stored: "10:00",
                                                      submitted: "11:00", isFocused: true), "11:00",
                       "an unrelated task update keeps the pending draft")
    }

    @MainActor
    func testWritesToOneTaskWaitForEachOtherWhileAnotherTaskCanSave() async throws {
        let status = try JSONDecoder().decode(DaemonStatusPayload.self, from: Data(statusJSON.utf8))
        let task = status.tasks[0]
        let other = status.tasks[1]
        let store = DaemonSettingsStore()
        let firstStarted = expectation(description: "first save starts")
        let otherStarted = expectation(description: "different task is independent")
        let secondStarted = expectation(description: "second save starts after first")
        var release: CheckedContinuation<Result<Data, Error>, Never>?
        var calls: [[String]] = []
        store.saveTask = { args in
            calls.append(args)
            if args.contains("first") {
                return await withCheckedContinuation { continuation in
                    release = continuation
                    firstStarted.fulfill()
                }
            }
            if args[3] == other.name { otherStarted.fulfill() }
            if args.contains("second") { secondStarted.fulfill() }
            return .success(Data("{}".utf8))
        }
        store.set(task, ["--every", "first"])
        XCTAssertEqual(store.savingTasks, [task.name], "controls disable synchronously when a save is submitted")
        store.set(task, ["--every", "second"])
        store.set(other, ["--every", "independent"])
        await fulfillment(of: [firstStarted, otherStarted], timeout: 1)
        XCTAssertEqual(calls.filter { $0[3] == task.name }.count, 1)
        XCTAssertTrue(store.savingTasks.contains(task.name), "the task stays disabled while another write is queued")
        release?.resume(returning: .success(Data("{}".utf8)))
        await fulfillment(of: [secondStarted], timeout: 1)
        XCTAssertEqual(calls.filter { $0[3] == task.name }.map { $0[5] }, ["first", "second"])
        for _ in 0 ..< 100 where !store.savingTasks.isEmpty { await Task.yield() }
        XCTAssertTrue(store.savingTasks.isEmpty, "controls re-enable after each task's final save finishes")
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
