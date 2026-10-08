// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusPomodoroTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import Genesis

/// Spec 22 (S6) T4 + the privacy policy. The plan is a value type, so its rules are tested
/// without a clock; the engine is tested against a real store on a temp path.
final class PomodoroPlanTests: XCTestCase {
    func testLongBreakLandsOnTheCycleBoundary() {
        let plan = PomodoroPlan(cycleLength: 4)
        // completedFlows counts the flow that just finished.
        XCTAssertEqual(plan.next(after: .flow, completedFlows: 1), .shortBreak)
        XCTAssertEqual(plan.next(after: .flow, completedFlows: 2), .shortBreak)
        XCTAssertEqual(plan.next(after: .flow, completedFlows: 3), .shortBreak)
        XCTAssertEqual(plan.next(after: .flow, completedFlows: 4), .longBreak)
        XCTAssertEqual(plan.next(after: .flow, completedFlows: 8), .longBreak)
    }

    func testEveryBreakIsFollowedByAFlow() {
        let plan = PomodoroPlan()
        XCTAssertEqual(plan.next(after: .shortBreak, completedFlows: 3), .flow)
        XCTAssertEqual(plan.next(after: .longBreak, completedFlows: 4), .flow)
    }

    func testCycleLengthOfZeroCannotDivideByZero() {
        let plan = PomodoroPlan(cycleLength: 0)
        XCTAssertEqual(plan.next(after: .flow, completedFlows: 1), .longBreak)
    }

    func testAutoStartIsPerPhaseKind() {
        let plan = PomodoroPlan(autoStartBreaks: true, autoStartFlows: false)
        XCTAssertTrue(plan.autoStarts(.shortBreak))
        XCTAssertTrue(plan.autoStarts(.longBreak))
        XCTAssertFalse(plan.autoStarts(.flow))
    }

    func testConfigDecodingIgnoresRubbishAndKeepsDefaults() {
        let config: [String: Any] = ["focus": ["timer": [
            "flowSec": 3_000, "cycleLength": 0, "autoStartFlows": true, "shortBreakSec": "nonsense",
        ] as [String: Any]] as [String: Any]]
        let plan = PomodoroPlan.from(appConfig: config)
        XCTAssertEqual(plan.flowSec, 3_000)
        XCTAssertEqual(plan.cycleLength, 4, "a zero cycle falls back rather than breaking the table")
        XCTAssertEqual(plan.shortBreakSec, 5 * 60, "a wrongly typed value keeps the default")
        XCTAssertTrue(plan.autoStartFlows)
    }
}

@MainActor
final class PomodoroEngineTests: XCTestCase {
    private var path: String!
    private var store: ActivityStore!
    private var engine: PomodoroEngine!

    override func setUpWithError() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-pomodoro-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        path = dir.appendingPathComponent("activity.db").path
        store = try ActivityStore(path: path)
        engine = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 300, shortBreakSec: 60))
    }

    override func tearDownWithError() throws {
        engine.stop()
        engine = nil
        store = nil
        try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent)
    }

    // MARK: - Pause accounting (the 2026-09-21 21:56 defect)

    /// Observed live: a 25-minute flow, overrunning, reported "62:15" REMAINING after a pause.
    /// Three pause rows had been left open by restarts, each counting up to now, so the engine
    /// believed 6,844 seconds of pause against 248 real ones and handed the time back.
    func testAnOrphanedPauseRowCannotInventPausedTime() throws {
        let base = Int64(Date().timeIntervalSince1970 * 1000) - 3_600_000
        let session = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                   plannedSec: 1500, startedMs: base,
                                                   state: ActivityStore.SessionState.running.rawValue,
                                                   cycleIndex: 0))
        // Two rows a dead process left open, plus one real 50-second pause.
        _ = try store.recordPause(sessionId: session, startedMs: base + 600_000, endedMs: nil, reason: .manual)
        _ = try store.recordPause(sessionId: session, startedMs: base + 900_000, endedMs: nil, reason: .manual)
        _ = try store.recordPause(sessionId: session, startedMs: base + 1_200_000,
                                  endedMs: base + 1_250_000, reason: .manual)

        let now = base + 3_600_000
        let naive = try store.pauses(sessionId: session)
            .reduce(Int64(0)) { $0 + ((($1.endedMs) ?? now) - $1.startedMs) }
        XCTAssertGreaterThan(naive, 4_000_000, "the shape of the defect: summed rows overlap")

        // Closing the orphans at the last recorded moment is what the engine does on resume.
        let closed = try store.closeOrphanedPauses(sessionId: session, keeping: nil, now: now)
        XCTAssertEqual(closed, 2)
        let repaired = try store.pausedMs(sessionId: session, now: now)
        XCTAssertLessThan(repaired, 1_300_000, "no row may count up to now once its process is gone")
        XCTAssertTrue(try store.openPauses(sessionId: session).isEmpty)
    }

    func testOverlappingPausesAreMergedRatherThanSummed() throws {
        let base = Int64(Date().timeIntervalSince1970 * 1000)
        let session = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                   plannedSec: 1500, startedMs: base,
                                                   state: ActivityStore.SessionState.running.rawValue,
                                                   cycleIndex: 0))
        // Two processes, same minute, twice recorded.
        _ = try store.recordPause(sessionId: session, startedMs: base + 60_000,
                                  endedMs: base + 120_000, reason: .manual)
        _ = try store.recordPause(sessionId: session, startedMs: base + 90_000,
                                  endedMs: base + 150_000, reason: .manual)
        XCTAssertEqual(try store.pausedMs(sessionId: session, now: base + 600_000), 90_000,
                       "60s and 60s that overlap by 30s are 90 seconds of pause, not 120")
    }

    func testPausingAnOverrunKeepsItOverrunningAndResumingNeverHandsTimeBack() throws {
        engine.start(.flow, seconds: 1)
        // Reach into the ledger the way the engine does: the phase ran out an hour ago.
        let session = try XCTUnwrap(try store.openSession())
        try store.endSession(id: session.id, at: Int64(Date().timeIntervalSince1970 * 1000),
                             state: .abandoned)

        let base = Int64(Date().timeIntervalSince1970 * 1000) - 3_600_000
        let overrun = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                   plannedSec: 1500, startedMs: base,
                                                   state: ActivityStore.SessionState.running.rawValue,
                                                   cycleIndex: 0))
        _ = try store.recordPause(sessionId: overrun, startedMs: base + 300_000, endedMs: nil, reason: .manual)

        let resumed = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 1500, allowOverrun: true))
        resumed.resumeOpenSessionIfAny()
        XCTAssertEqual(resumed.state, .overrun, "a flow that ran out while the app was gone is overrunning")
        XCTAssertLessThanOrEqual(resumed.remainingSec, 0, "and it may never report time remaining")

        resumed.pause()
        XCTAssertEqual(resumed.state, .paused)
        let atPause = resumed.remainingSec
        resumed.resume()
        XCTAssertEqual(resumed.state, .overrun, "resuming an overrun returns to overrun, not to running")
        XCTAssertLessThanOrEqual(resumed.remainingSec, 0)
        XCTAssertLessThanOrEqual(abs(resumed.remainingSec - atPause), 2,
                                 "the clock continues where it was, it does not jump")
        resumed.stop()
    }

    func testAPausedPhaseIsStillPausedAfterARestart() throws {
        engine.start(.flow)
        engine.pause()
        let session = try XCTUnwrap(try store.openSession())
        XCTAssertEqual(session.state, ActivityStore.SessionState.paused.rawValue,
                       "the ledger has to carry the pause, or a restart resumes the timer by itself")

        let restarted = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 300))
        restarted.resumeOpenSessionIfAny()
        XCTAssertEqual(restarted.state, .paused)
        XCTAssertEqual(try store.openPauses(sessionId: session.id).count, 1,
                       "it adopts the open row rather than opening a second one")

        restarted.resume()
        XCTAssertEqual(restarted.state, .running)
        XCTAssertTrue(try store.openPauses(sessionId: session.id).isEmpty, "and closes it on resume")
        restarted.stop()
    }

    func testStartRecordsARunningSessionAndArmsDND() throws {
        var begun = 0, ended = 0
        engine.beginDND = { begun += 1 }
        engine.endDND = { ended += 1 }

        engine.start(.flow, tag: "col-fe")
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.remainingSec, 300)
        XCTAssertEqual(begun, 1)
        XCTAssertEqual(ended, 0)

        let open = try XCTUnwrap(try store.openSession())
        XCTAssertEqual(open.kind, "flow")
        XCTAssertEqual(open.tag, "col-fe")
        XCTAssertEqual(open.state, "running")

        engine.stop()
        XCTAssertEqual(ended, 1, "DND must be released exactly once when the phase ends")
        XCTAssertNil(try store.openSession())
    }

    func testBreaksDoNotArmDND() {
        var begun = 0
        engine.beginDND = { begun += 1 }
        engine.start(.shortBreak)
        XCTAssertEqual(begun, 0, "a break is not work; notifications may come through")
    }

    func testSessionChangeCallbackFiresOnStartAndEnd() {
        var seen: [Int64?] = []
        engine.onSessionChange = { seen.append($0) }
        engine.start(.flow)
        engine.stop()
        XCTAssertEqual(seen.count, 2)
        XCTAssertNotNil(seen.first ?? nil)
        XCTAssertNil(seen.last ?? Int64(1), "the recorder must be told the session is over")
    }

    func testPauseIsRecordedAndReleasesDND() throws {
        var ended = 0
        engine.endDND = { ended += 1 }
        engine.start(.flow)
        engine.pause()
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(ended, 1, "a paused flow must not keep the machine in Do Not Disturb")

        let sessionId = try XCTUnwrap(try store.openSession()).id
        XCTAssertGreaterThan(try store.pausedMs(sessionId: sessionId, now: Int64(Date().timeIntervalSince1970 * 1000) + 5_000), 0)

        engine.resume()
        XCTAssertEqual(engine.state, .running)
    }

    func testSkipEndsTheSessionAsDoneAndAdvances() throws {
        engine.plan.autoStartBreaks = false
        engine.start(.flow)
        engine.skip()
        XCTAssertEqual(engine.phase, .shortBreak, "after a flow comes a break, even a skipped one")
        XCTAssertEqual(engine.completedFlows, 1)
        XCTAssertNil(try store.openSession())
        let sessions = try store.sessions(from: 0, to: Int64(Date().timeIntervalSince1970 * 1000) + 1_000)
        XCTAssertEqual(sessions.first?.state, "done", "a skipped flow is recorded, not erased")
    }

    func testCrashResumeTakesRemainingFromTheWallClock() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        _ = try store.startSession(.init(kind: "flow", plannedSec: 300, startedMs: now - 60_000,
                                         state: "running", cycleIndex: 2, tag: "col-fe"))
        engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.phase, .flow)
        XCTAssertEqual(engine.tag, "col-fe")
        XCTAssertEqual(Double(engine.remainingSec), 240, accuracy: 2,
                       "a minute of downtime costs a minute of the phase")
    }

    func testCrashResumeOfAPausedSessionStaysPaused() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        _ = try store.startSession(.init(kind: "flow", plannedSec: 300, startedMs: now - 10_000,
                                         state: "paused", cycleIndex: 0))
        engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .paused, "the app must not silently restart a paused flow")
    }

    func testInterruptionsOnlyCountDuringAFlow() throws {
        engine.start(.shortBreak)
        engine.recordInterruption()
        XCTAssertEqual(engine.interruptions, 0, "leaving a break is not an interruption")

        engine.start(.flow)
        engine.recordInterruption()
        engine.recordInterruption()
        XCTAssertEqual(engine.interruptions, 2)
        let open = try XCTUnwrap(try store.openSession())
        XCTAssertEqual(open.interruptions, 2, "the count must survive to the session card")
    }

    func testGoBackReturnsToTheFlowASkipLeft() throws {
        engine.plan.autoStartBreaks = false
        engine.start(.flow, tag: "deep")
        engine.skip()
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(engine.completedFlows, 1)

        engine.goBack()
        XCTAssertEqual(engine.phase, .flow, "a mis-skip has a way back")
        XCTAssertEqual(engine.completedFlows, 0, "stepping back undoes the flow the skip counted")
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.tag, "deep", "the tag survives the step back")
    }

    func testGoBackFromAFlowLandsOnTheBreakBeforeIt() {
        engine.plan.cycleLength = 4
        engine.start(.flow)
        engine.goBack()
        XCTAssertEqual(engine.phase, .shortBreak)
    }

    func testPreviousPhaseTableMirrorsNext() {
        let plan = PomodoroPlan(cycleLength: 4)
        // Whatever `next` produced, `previous` has to undo.
        XCTAssertEqual(plan.previous(before: .shortBreak, completedFlows: 1), .flow)
        XCTAssertEqual(plan.previous(before: .longBreak, completedFlows: 4), .flow)
        XCTAssertEqual(plan.previous(before: .flow, completedFlows: 4), .longBreak,
                       "on a cycle boundary the break behind you was the long one")
        XCTAssertEqual(plan.previous(before: .flow, completedFlows: 2), .shortBreak)
        XCTAssertEqual(plan.previous(before: .flow, completedFlows: 0), .shortBreak,
                       "nothing precedes the first flow; a short break is the safe answer")
    }

    func testAPhaseThatExpiredWhileTheAppWasClosedCompletesAtItsRealEnd() throws {
        // A break that ran out overnight must not resume as "0:00 left" and must not invent
        // focus time: it completes at the moment it actually ended, and the next flow waits.
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let started = now - 3_600_000
        _ = try store.startSession(.init(kind: "short_break", plannedSec: 300, startedMs: started,
                                         state: "running", cycleIndex: 1))
        engine.resumeOpenSessionIfAny()

        XCTAssertEqual(engine.state, .idle, "nobody was here to start the next phase")
        XCTAssertEqual(engine.phase, .flow, "a finished break queues the next flow")
        XCTAssertEqual(engine.remainingSec, 300, "the queued flow shows its full length")
        XCTAssertNil(try store.openSession())

        let session = try XCTUnwrap(try store.sessions(from: 0, to: now + 1_000).first)
        XCTAssertEqual(session.state, "done")
        XCTAssertEqual(session.endedMs, started + 300_000,
                       "the break ended five minutes in, not when the app came back")
    }

    func testAFlowThatExpiredWhileTheAppWasClosedComesBackOverrunning() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        _ = try store.startSession(.init(kind: "flow", plannedSec: 300, startedMs: now - 600_000,
                                         state: "running", cycleIndex: 0, tag: "deep"))
        engine.resumeOpenSessionIfAny()

        XCTAssertEqual(engine.state, .overrun, "finishing a flow is still the user's call")
        XCTAssertEqual(engine.tag, "deep")
        XCTAssertLessThan(engine.remainingSec, 0, "an overrunning flow counts up")
        XCTAssertNotNil(try store.openSession(), "the session stays open until it is ended")
    }

    func testCliIntentStartsAFlowExactlyOnce() throws {
        try store.pushIntent(kind: "start", payload: ["minutes": 12, "tag": "from-cli"])
        let first = try store.takeIntents()
        XCTAssertEqual(first.count, 1)
        engine.apply(intent: first[0])
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.remainingSec, 12 * 60, "the CLI's minutes must win over the default")
        XCTAssertEqual(engine.tag, "from-cli")

        XCTAssertTrue(try store.takeIntents().isEmpty,
                      "a consumed intent must never run twice, whatever drains next")
    }

    func testUnknownIntentIsIgnoredRatherThanFatal() throws {
        try store.pushIntent(kind: "teleport", payload: [:])
        let intents = try store.takeIntents()
        engine.apply(intent: intents[0])
        XCTAssertEqual(engine.state, .idle, "an older app must survive a newer CLI")
    }

    func testStartingAgainClosesThePreviousSession() throws {
        engine.start(.flow)
        engine.start(.flow)
        let all = try store.sessions(from: 0, to: Int64(Date().timeIntervalSince1970 * 1000) + 1_000)
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all.first?.state, "abandoned")
        XCTAssertEqual(all.last?.state, "running")
    }
}

final class FocusSettingsTests: XCTestCase {
    func testPasswordManagersAreExcludedBeforeAnyoneConfiguresAnything() {
        let settings = FocusSettings()
        XCTAssertFalse(settings.records(bundle: "com.1password.1password"))
        XCTAssertTrue(settings.records(bundle: "dev.foltyn.genesis"))
    }

    func testUserExclusionsAddToTheDefaultsRatherThanReplacingThem() {
        let config: [String: Any] = ["focus": ["excludedBundles": ["com.apple.Messages"]] as [String: Any]]
        let settings = FocusSettings.from(appConfig: config)
        XCTAssertFalse(settings.records(bundle: "com.apple.Messages"))
        XCTAssertFalse(settings.records(bundle: "com.1password.1password"),
                       "a user list must not silently re-enable a password manager")
    }

    func testTitleModes() {
        var settings = FocusSettings()
        XCTAssertEqual(settings.title("PR #65", appName: "Brave"), "PR #65")

        settings.titleMode = .appOnly
        XCTAssertEqual(settings.title("PR #65", appName: "Brave"), "Brave")

        settings.titleMode = .hashed
        let first = settings.title("PR #65", appName: "Brave")
        let again = settings.title("PR #65", appName: "Brave")
        XCTAssertEqual(first, again, "the same window must hash the same, or switch counts break")
        XCTAssertNotEqual(first, settings.title("PR #66", appName: "Brave"))
        XCTAssertTrue(first?.hasPrefix("sha256:") ?? false)
    }

    func testURLModes() {
        var settings = FocusSettings()
        let url = "https://github.com/anthropics/claude-code/pull/65"

        XCTAssertEqual(settings.urlParts(url).host, "github.com")
        XCTAssertNil(settings.urlParts(url).path, "paths are off until asked for")

        settings.urlMode = .hostPath
        XCTAssertEqual(settings.urlParts(url).path, "/anthropics/claude-code/pull/65")

        settings.urlMode = .off
        XCTAssertNil(settings.urlParts(url).host)
    }

    func testExcludedHostRecordsNothingAtAll() {
        var settings = FocusSettings()
        settings.excludedHosts = ["mail.proton.me"]
        let parts = settings.urlParts("https://mail.proton.me/u/0/inbox")
        XCTAssertNil(parts.host)
        XCTAssertNil(parts.path)
    }

    func testProjectRulePrecedenceIsCmuxThenTitleThenHost() {
        let rules: [[String: Any]] = [
            ["name": "col-fe", "cmuxSession": "col-"],
            ["name": "genesis", "titleContains": "GenesisPlayground"],
            ["name": "vault", "host": "obsidian.md"],
        ]
        let config: [String: Any] = ["focus": ["projects": rules] as [String: Any]]
        let settings = FocusSettings.from(appConfig: config)

        XCTAssertEqual(settings.project(cmuxSession: "col-302921-pr", title: "GenesisPlayground", host: nil),
                       "col-fe", "cmux wins over a title match")
        XCTAssertEqual(settings.project(cmuxSession: nil, title: "GenesisPlayground — x", host: "obsidian.md"),
                       "genesis", "a title match wins over a host match")
        XCTAssertEqual(settings.project(cmuxSession: nil, title: nil, host: "help.obsidian.md"),
                       "vault", "host rules match subdomains")
        XCTAssertNil(settings.project(cmuxSession: nil, title: "something else", host: "example.com"),
                     "no rule means unattributed, never a guess")
    }

    func testCmuxTitlesResolveToSessionAndPane() {
        XCTAssertEqual(CmuxAttribution.parse(title: "genesisplayground-a7 · editor", bundle: "com.cmuxterm.app").session,
                       "genesisplayground-a7")
        XCTAssertEqual(CmuxAttribution.parse(title: "genesisplayground-a7 · editor", bundle: "com.cmuxterm.app").pane,
                       "editor")
        XCTAssertNil(CmuxAttribution.parse(title: "anything", bundle: "com.apple.Terminal").session,
                     "only cmux windows carry cmux attribution")
    }
}
