// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusFlowEdgeTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// The edges of the flow's clock: pause, idle and resume in odd orders, overrun, relaunch on a
/// damaged ledger, the pause rows the ledger keeps, the nudge, and the tick itself.
///
/// Same rig as `FocusFlowLifecycleTests`: the engine reads `clock`, `FocusIdleWatch.step` takes
/// its idle seconds as values, so nothing here sleeps or waits for a real timer.
@MainActor
final class FocusFlowEdgeTests: XCTestCase {
    private var dir: URL!
    private var store: ActivityStore!
    private var engine: PomodoroEngine!
    private var watch: FocusIdleWatch!
    private var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var events: [String] = []
    private var announced: [String] = []
    private var boundaries = 0
    private var phaseEnds: [String] = []
    private var nudges: [Int] = []

    private var t0: Date { Date(timeIntervalSince1970: 1_800_000_000) }

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-flow-edge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = try ActivityStore(path: dir.appendingPathComponent("activity.db").path)
        now = t0
        events = []
        announced = []
        boundaries = 0
        phaseEnds = []
        nudges = []
        engine = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 1500, shortBreakSec: 300))
        engine.clock = { [unowned self] in self.now }
        engine.announcePhaseChange = { [weak self] finished, next, auto in
            self?.announced.append("\(finished.rawValue)>\(next.rawValue):\(auto)")
        }
        engine.onBoundary = { [weak self] in self?.boundaries += 1 }
        engine.onPhaseEnd = { [weak self] phase, endedMs in
            guard let self else { return }
            phaseEnds.append("\(phase.rawValue)@\((endedMs - ms(0)) / 1000)")
        }
        watch = FocusIdleWatch(engine: engine, now: now)
        watch.onAutoPause = { [weak self] in self?.events.append("pause") }
        watch.onAutoResume = { [weak self] in self?.events.append("resume") }
        watch.onNudge = { [weak self] in
            guard let self else { return }
            events.append("nudge")
            nudges.append(Int(now.timeIntervalSince(t0)))
        }
    }

    override func tearDownWithError() throws {
        engine.stop()
        engine = nil
        watch = nil
        store = nil
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Helpers

    /// Moves the clock to `seconds` after t0.
    private func at(_ seconds: TimeInterval) {
        now = t0.addingTimeInterval(seconds)
    }

    /// One idle-watch poll at the current clock.
    private func poll(idle: Double, sinceKey: Double? = nil) {
        watch.step(now: now, idleSec: idle, sinceKeySec: sinceKey ?? idle)
    }

    /// A poll with a key press in it.
    private func typing() {
        poll(idle: 0.3, sinceKey: 0.3)
    }

    private func ms(_ seconds: TimeInterval) -> Int64 {
        Int64(t0.addingTimeInterval(seconds).timeIntervalSince1970 * 1000)
    }

    private func openId() throws -> Int64 {
        try XCTUnwrap(try store.openSession()).id
    }

    /// Writes a session the way a previous process left it. Relaunch with `resumeOpenSessionIfAny`.
    @discardableResult
    private func seed(_ kind: ActivityStore.SessionKind = .flow, planned: Int = 1500, startedAt start: TimeInterval = 0,
                      state: ActivityStore.SessionState = .running,
                      pauses: [(start: TimeInterval, end: TimeInterval?, reason: ActivityStore.PauseReason)] = []) throws -> Int64 {
        let id = try store.startSession(.init(kind: kind.rawValue, plannedSec: planned, startedMs: ms(start),
                                              state: state.rawValue, cycleIndex: 0))
        for pause in pauses {
            try store.recordPause(sessionId: id, startedMs: ms(pause.start), endedMs: pause.end.map { ms($0) },
                                  reason: pause.reason)
        }
        return id
    }

    /// Makes `lastRecordedMs` answer `seconds`: the last moment the old process wrote anything.
    private func lastSeen(at seconds: TimeInterval) throws {
        try store.openSegment(.init(startedMs: ms(seconds - 10), endedMs: ms(seconds),
                                    appBundle: "com.example.editor", appName: "Editor"))
    }

    /// The pause rows of one session describe real, separate stretches of time.
    private func assertLedgerSane(_ id: Int64, file: StaticString = #filePath, line: UInt = #line) throws {
        let session = try XCTUnwrap(try store.session(id: id), file: file, line: line)
        let rows = try store.pauses(sessionId: id)
        XCTAssertLessThanOrEqual(rows.filter { $0.endedMs == nil }.count, 1, "at most one open pause",
                                 file: file, line: line)
        if session.endedMs != nil {
            XCTAssertTrue(rows.allSatisfy { $0.endedMs != nil }, "an ended session has no open pause",
                          file: file, line: line)
        }
        for row in rows {
            XCTAssertGreaterThanOrEqual(row.startedMs, session.startedMs, "a pause never starts before its session",
                                        file: file, line: line)
            if let end = row.endedMs {
                XCTAssertGreaterThanOrEqual(end, row.startedMs, file: file, line: line)
            }
        }
        for (a, b) in zip(rows, rows.dropFirst()) {
            XCTAssertLessThanOrEqual(a.endedMs ?? .max, b.startedMs, "pause rows overlap", file: file, line: line)
        }
    }

    // MARK: - Pause, idle and resume in odd orders

    func testAManualPauseThenAbsenceAddsNoSecondPauseRow() throws {
        engine.start(.flow)
        let id = try openId()
        at(50); engine.pause()
        at(500); poll(idle: 400)
        at(501); poll(idle: 0.1)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .manual)
        XCTAssertEqual(try store.pauses(sessionId: id).count, 1)
        XCTAssertEqual(events, [])
        try assertLedgerSane(id)
    }

    func testAnIdlePauseResumedByHandIsNotResumedAgainByInput() throws {
        engine.start(.flow)
        let id = try openId()
        at(100); poll(idle: 70)                    // away since t0 + 30
        at(150); engine.resume()
        XCTAssertEqual(engine.state, .running)
        XCTAssertNil(engine.pauseReason)
        at(151); poll(idle: 0.2)
        XCTAssertEqual(events, ["pause"], "a hand resume is not signalled as an automatic one")
        XCTAssertEqual(try store.pauses(sessionId: id).map(\.endedMs), [ms(150)])
        at(200); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1500 - 80, "200 s of wall clock minus 120 s away")
    }

    /// The HUD and the status item turn a press while paused into `resume()`, so `pause()` on a
    /// paused flow only arrives from the CLI. It is a no-op: the reason stays idle.
    func testDoesPressingPauseDuringAnIdlePauseMakeItManual_NoTheReasonStaysIdle() throws {
        engine.start(.flow)
        let id = try openId()
        at(100); poll(idle: 70)
        engine.pause()
        XCTAssertEqual(engine.pauseReason, .idle)
        XCTAssertEqual(try store.pauses(sessionId: id).count, 1)
        at(200); poll(idle: 0.3)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(events, ["pause", "resume"])
    }

    func testTurningResumeOnActivityOffWhileIdlePausedHoldsThePause() {
        engine.start(.flow)
        at(100); poll(idle: 70)                    // away since t0 + 30
        engine.plan.resumeOnActivity = false
        at(200); poll(idle: 0.2)
        XCTAssertEqual(engine.state, .paused)
        engine.plan.resumeOnActivity = true
        at(210); poll(idle: 0.2)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(events, ["pause", "resume"])
        XCTAssertEqual(engine.remainingSec, 1500 - 30)
    }

    func testRaisingIdlePauseSecMidFlowUsesTheNewThreshold() throws {
        engine.start(.flow)
        at(100)
        engine.plan.idlePauseSec = 300
        poll(idle: 120)
        XCTAssertEqual(engine.state, .running)
        at(400); poll(idle: 300)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, 1400)
        XCTAssertEqual(try store.pauses(sessionId: openId()).map(\.startedMs), [ms(100)])
    }

    func testLoweringIdlePauseSecMidFlowPausesOnTheNextPoll() {
        engine.start(.flow)
        at(100); poll(idle: 45)
        XCTAssertEqual(engine.state, .running)
        engine.plan.idlePauseSec = 30
        poll(idle: 45)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, 1500 - 55)
    }

    /// Turning idle pausing off must not strand a flow it already paused.
    func testIdlePauseSecZeroWhileIdlePausedStillResumesOnInputAndNeverPausesAgain() {
        engine.start(.flow)
        at(100); poll(idle: 70)
        engine.plan.idlePauseSec = 0
        at(200); poll(idle: 0.2)
        XCTAssertEqual(engine.state, .running)
        at(1000); poll(idle: 700)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(events, ["pause", "resume"])
    }

    /// A resume from the CLI or MCP while you are still away, then the next poll re-pauses. The
    /// backdate reached into the pause that had just ended, so the frozen clock subtracted those
    /// minutes twice and showed the full 25:00 instead of 24:21.
    func testARePauseAfterARemoteResumeDoesNotOverlapThePreviousPause() throws {
        engine.start(.flow)
        let id = try openId()
        at(100); poll(idle: 61)                    // away since t0 + 39
        XCTAssertEqual(engine.remainingSec, 1461)
        at(150); engine.resume()                   // `genesis focus resume`, nobody at the desk
        at(151); poll(idle: 112)                   // still away since t0 + 39
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, 1461, "the frozen clock shows the 39 s of work, once")
        try assertLedgerSane(id)
        at(300); poll(idle: 0.2)
        XCTAssertEqual(engine.remainingSec, 1461)
        XCTAssertEqual(try store.pausedMs(sessionId: id, now: ms(300)), 261_000)
        try assertLedgerSane(id)
    }

    // MARK: - Overrun

    func testOverrunAnnouncesOnceAcrossManyPauseAndIdleCycles() {
        engine.start(.flow)
        at(1600); engine.tick()
        XCTAssertEqual(engine.state, .overrun)
        for cycle in 0 ..< 3 {
            let base = 1700 + Double(cycle) * 300
            at(base); engine.pause()
            XCTAssertLessThanOrEqual(engine.remainingSec, 0)
            at(base + 50); engine.resume()
            XCTAssertEqual(engine.state, .overrun)
            XCTAssertLessThanOrEqual(engine.remainingSec, 0)
            at(base + 100); poll(idle: 70)
            XCTAssertEqual(engine.state, .paused)
            XCTAssertLessThanOrEqual(engine.remainingSec, 0)
            at(base + 200); poll(idle: 0.3)
            XCTAssertEqual(engine.state, .overrun)
            engine.tick()
            XCTAssertLessThanOrEqual(engine.remainingSec, 0)
        }
        XCTAssertEqual(announced, ["flow>short_break:false"])
        XCTAssertEqual(boundaries, 1)
        XCTAssertEqual(phaseEnds, ["flow@1600"])
    }

    /// Away since 30 s before zero, noticed 30 s after it. The overrun already rang, so it stays an
    /// overrun: the clock holds at zero for the 30 s the backdate handed back, then counts up.
    func testABackdatedPauseAcrossZeroNeverHandsBackPositiveTime() {
        engine.start(.flow)
        at(1490); engine.tick()
        XCTAssertEqual(engine.remainingSec, 10)
        at(1520); engine.tick()
        XCTAssertEqual(engine.state, .overrun)
        at(1530); poll(idle: 60)                   // away since t0 + 1470
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, 0)
        at(2000); poll(idle: 0.2)
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertEqual(engine.remainingSec, 0)
        at(2020); engine.tick()
        XCTAssertEqual(engine.remainingSec, 0)
        at(2040); engine.tick()
        XCTAssertEqual(engine.remainingSec, -10)
        XCTAssertEqual(announced.count, 1)
    }

    func testSkipFromOverrunCountsTheFlowAndStartsTheBreakQuietly() throws {
        engine.start(.flow)
        let id = try openId()
        at(1600); engine.tick()
        at(1650); engine.skip()
        XCTAssertEqual(engine.completedFlows, 1)
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.remainingSec, 300)
        XCTAssertEqual(announced.count, 1)
        let flow = try XCTUnwrap(try store.session(id: id))
        XCTAssertEqual(flow.state, ActivityStore.SessionState.done.rawValue)
        XCTAssertEqual(flow.endedMs, ms(1650))
    }

    /// Going back from a flow lands on the break before it, even from an overrun.
    func testGoBackFromAnOverrunAbandonsItAndStartsTheBreakBeforeIt() throws {
        engine.start(.flow)
        let id = try openId()
        at(1600); engine.tick()
        at(1650); engine.goBack()
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.completedFlows, 0)
        XCTAssertEqual(announced.count, 1, "going back is not a boundary")
        XCTAssertEqual(try store.session(id: id)?.state, ActivityStore.SessionState.abandoned.rawValue)
    }

    func testGoBackFromAnIdlePausedOverrunClosesThePauseRow() throws {
        engine.start(.flow)
        let id = try openId()
        at(1600); engine.tick()
        at(1700); poll(idle: 90)
        XCTAssertEqual(engine.state, .paused)
        at(1750); engine.goBack()
        XCTAssertEqual(try store.pauses(sessionId: id).map(\.endedMs), [ms(1750)])
        XCTAssertEqual(try store.session(id: id)?.state, ActivityStore.SessionState.abandoned.rawValue)
        try assertLedgerSane(id)
        XCTAssertEqual(try store.pauses(sessionId: openId()), [], "the new break starts clean")
    }

    func testSkipFromAnIdlePausedOverrunClosesThePauseRow() throws {
        engine.start(.flow)
        let id = try openId()
        at(1600); engine.tick()
        at(1700); poll(idle: 90)
        at(1750); engine.skip()
        XCTAssertEqual(try store.pauses(sessionId: id).map(\.endedMs), [ms(1750)])
        XCTAssertEqual(try store.session(id: id)?.state, ActivityStore.SessionState.done.rawValue)
        XCTAssertEqual(engine.completedFlows, 1)
        XCTAssertEqual(announced.count, 1)
        try assertLedgerSane(id)
    }

    func testLongBreakLandsOnTheFourthSkippedFlowAndSkippedBreaksDoNotCount() throws {
        var second: TimeInterval = 0
        for flow in 1 ... 4 {
            second += 1; at(second); engine.start(.flow)
            second += 1; at(second); engine.skip()
            XCTAssertEqual(engine.completedFlows, flow)
            XCTAssertEqual(engine.phase, flow == 4 ? .longBreak : .shortBreak)
            XCTAssertEqual(engine.state, .running)
            second += 1; at(second); engine.skip()
            XCTAssertEqual(engine.completedFlows, flow, "a skipped break is not a flow")
            XCTAssertEqual(engine.phase, .flow)
            XCTAssertEqual(engine.state, .idle, "flows do not start by themselves")
        }
        XCTAssertEqual(announced, [
            "flow>short_break:true", "short_break>flow:false",
            "flow>short_break:true", "short_break>flow:false",
            "flow>short_break:true", "short_break>flow:false",
            "flow>long_break:true", "long_break>flow:false",
        ])
        let sessions = try store.sessions(from: ms(0), to: ms(100))
        XCTAssertEqual(sessions.filter { $0.kind == "flow" }.map(\.cycleIndex), [0, 1, 2, 3])
        XCTAssertEqual(sessions.filter { $0.kind == "long_break" }.map(\.cycleIndex), [4])
    }

    func testGoBackFromTheLongBreakKeepsTheBoundaryWhereItWas() {
        var second: TimeInterval = 0
        for _ in 1 ... 3 {
            second += 1; at(second); engine.start(.flow)
            second += 1; at(second); engine.skip()
            second += 1; at(second); engine.skip()
        }
        engine.start(.flow)
        engine.skip()
        XCTAssertEqual(engine.phase, .longBreak)
        engine.goBack()
        XCTAssertEqual(engine.phase, .flow)
        XCTAssertEqual(engine.completedFlows, 3)
        engine.skip()
        XCTAssertEqual(engine.phase, .longBreak)
        XCTAssertEqual(engine.completedFlows, 4)
    }

    // MARK: - Relaunch

    func testRelaunchRunningWithAClosedPauseExcludesIt() throws {
        try seed(pauses: [(100, 200, .manual)])
        at(500); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .running)
        XCTAssertTrue(engine.isTicking)
        XCTAssertEqual(engine.remainingSec, 1100)
        at(510); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1090)
    }

    func testRelaunchPausedByHandStaysFrozenUntilResumedByHand() throws {
        let id = try seed(state: .paused, pauses: [(100, nil, .manual)])
        at(5000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .manual)
        XCTAssertFalse(engine.isTicking)
        XCTAssertEqual(engine.remainingSec, 1400)
        at(6000); engine.tick()
        poll(idle: 0.2)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, 1400)
        engine.resume()
        XCTAssertEqual(engine.state, .running)
        XCTAssertTrue(engine.isTicking)
        XCTAssertEqual(engine.remainingSec, 1400)
        at(6010); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1390)
        XCTAssertEqual(try store.openPauses(sessionId: id), [])
        try assertLedgerSane(id)
    }

    /// An `auto` pause is neither yours nor the idle watch's: input does not resume it, and
    /// typing over it earns the "nothing is running" nudge.
    func testIsARestoredAutoPauseResumedByInput_NoItIsNudged() throws {
        try seed(state: .paused, pauses: [(100, nil, .auto)])
        at(5000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.pauseReason, .auto)
        for second in 5000 ... 5004 {
            at(Double(second)); typing()
        }
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(events, ["nudge"])
    }

    /// An older ledger marked the session paused but wrote no pause row. The row opened at relaunch
    /// starts at the last recorded moment, and the clock must be derived AFTER it exists: before,
    /// the whole downtime counted as work and a flow with 800 s left came back as a 3500 s overrun.
    func testRelaunchPausedWithoutAPauseRowFreezesAtTheLastRecordedMoment() throws {
        let id = try seed(state: .paused)
        try lastSeen(at: 700)
        at(5000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .auto)
        XCTAssertEqual(try store.openPauses(sessionId: id).map(\.startedMs), [ms(700)])
        XCTAssertEqual(engine.remainingSec, 800)
        at(5100); engine.resume()
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.remainingSec, 800)
        at(5110); engine.tick()
        XCTAssertEqual(engine.remainingSec, 790)
    }

    /// Nobody heard zero while the app was closed, so the skip that ends the overrun rings.
    func testRelaunchOfAnExpiredFlowWithOverrunOnTicksAndTheSkipAnnounces() throws {
        try seed()
        at(2000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertTrue(engine.isTicking)
        XCTAssertEqual(engine.remainingSec, -500)
        at(2010); engine.tick()
        XCTAssertEqual(engine.remainingSec, -510)
        XCTAssertEqual(announced, [], "the tick of a restored overrun does not ring")
        engine.skip()
        XCTAssertEqual(announced, ["flow>short_break:true"])
        XCTAssertEqual(engine.phase, .shortBreak)
    }

    func testRelaunchOfAnExpiredFlowWithOverrunOffCompletesAtItsRealEnd() throws {
        engine.plan.allowOverrun = false
        let id = try seed(pauses: [(100, 160, .manual)])
        at(5000); engine.resumeOpenSessionIfAny()
        let flow = try XCTUnwrap(try store.session(id: id))
        XCTAssertEqual(flow.state, ActivityStore.SessionState.done.rawValue)
        XCTAssertEqual(flow.endedMs, ms(1560), "planned length plus the minute paused")
        XCTAssertEqual(engine.completedFlows, 1)
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(engine.state, .idle)
        XCTAssertEqual(engine.remainingSec, 300)
        XCTAssertFalse(engine.isTicking)
        XCTAssertEqual(announced, [])
        XCTAssertNil(try store.openSession())
    }

    func testRelaunchOfAnExpiredBreakQueuesTheFlowWithoutStartingIt() throws {
        engine.plan.autoStartFlows = true
        let id = try seed(.shortBreak, planned: 300)
        at(1000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(try store.session(id: id)?.endedMs, ms(300))
        XCTAssertEqual(engine.phase, .flow)
        XCTAssertEqual(engine.state, .idle, "nobody was here to start it")
        XCTAssertEqual(engine.remainingSec, 1500)
        XCTAssertFalse(engine.isTicking)
        XCTAssertEqual(engine.completedFlows, 0)
        XCTAssertNil(try store.openSession())
    }

    /// Only the newest open row is adopted. Each older one closes where the next one began, so
    /// the merged pause is one stretch, not three that count up forever.
    func testRelaunchWithSeveralOpenPauseRowsAdoptsOnlyTheNewest() throws {
        let id = try seed(state: .paused, pauses: [(100, nil, .idle), (200, nil, .manual), (300, nil, .idle)])
        at(1000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.pauseReason, .idle)
        let rows = try store.pauses(sessionId: id)
        XCTAssertEqual(rows.map(\.endedMs), [ms(200), ms(300), nil])
        XCTAssertEqual(engine.remainingSec, 1400)
        at(1100); engine.resume()
        at(1110); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1390)
        XCTAssertEqual(try store.openPauses(sessionId: id), [])
        try assertLedgerSane(id)
    }

    /// A running session cannot own an open pause. The orphan closes at the last recorded moment.
    func testRelaunchRunningWithAnOpenPauseRowClosesItAtTheLastRecordedMoment() throws {
        let id = try seed(pauses: [(400, nil, .idle)])
        try lastSeen(at: 450)
        at(1000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .running)
        XCTAssertNil(engine.pauseReason)
        XCTAssertTrue(engine.isTicking)
        XCTAssertEqual(try store.pauses(sessionId: id).map(\.endedMs), [ms(450)])
        XCTAssertEqual(engine.remainingSec, 550)
    }

    func testRelaunchWithMorePauseThanWallTimeIsClampedToThePlannedLength() throws {
        try seed(startedAt: 1000, pauses: [(0, 5000, .manual)])
        at(3000); engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.remainingSec, 1500, "never above the planned length")
        at(3010); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1490)
    }

    // MARK: - Ledger integrity

    func testAMixedSequenceKeepsOneOpenPauseAndStopClosesAll() throws {
        engine.start(.flow)
        let id = try openId()
        at(100); engine.pause();       try assertLedgerSane(id)
        at(150); engine.pause();       try assertLedgerSane(id)
        at(200); engine.resume();      try assertLedgerSane(id)
        at(300); poll(idle: 70);       try assertLedgerSane(id)   // away since t0 + 230
        at(310); engine.pause();       try assertLedgerSane(id)
        at(400); poll(idle: 0.2);      try assertLedgerSane(id)
        at(500); engine.pause();       try assertLedgerSane(id)
        at(600); engine.stop();        try assertLedgerSane(id)
        let rows = try store.pauses(sessionId: id)
        XCTAssertEqual(rows.map(\.reason), ["manual", "idle", "manual"])
        XCTAssertEqual(rows.map(\.startedMs), [ms(100), ms(230), ms(500)])
        XCTAssertEqual(rows.map(\.endedMs), [ms(200), ms(400), ms(600)])
        let sum = rows.reduce(Int64(0)) { $0 + ($1.endedMs! - $1.startedMs) }
        XCTAssertEqual(try store.pausedMs(sessionId: id, now: ms(600)), sum)
        XCTAssertEqual(sum, 370_000)
    }

    func testSkipAndGoBackCloseTheOpenPause() throws {
        engine.start(.flow)
        let flowId = try openId()
        at(100); engine.pause()
        at(200); engine.skip()
        XCTAssertEqual(try store.pauses(sessionId: flowId).map(\.endedMs), [ms(200)])
        XCTAssertEqual(try store.session(id: flowId)?.endedMs, ms(200))
        let breakId = try openId()
        at(250); engine.pause()
        at(300); engine.goBack()
        XCTAssertEqual(try store.pauses(sessionId: breakId).map(\.endedMs), [ms(300)])
        XCTAssertEqual(try store.session(id: breakId)?.state, ActivityStore.SessionState.abandoned.rawValue)
        XCTAssertEqual(engine.phase, .flow)
        XCTAssertEqual(engine.completedFlows, 0)
        try assertLedgerSane(flowId)
        try assertLedgerSane(breakId)
    }

    func testStartingAgainWhilePausedClosesTheOldPause() throws {
        engine.start(.flow)
        let old = try openId()
        at(100); engine.pause()
        at(200); engine.start(.flow)
        XCTAssertEqual(try store.pauses(sessionId: old).map(\.endedMs), [ms(200)])
        XCTAssertEqual(try store.session(id: old)?.state, ActivityStore.SessionState.abandoned.rawValue)
        XCTAssertEqual(try store.pauses(sessionId: openId()), [])
        XCTAssertEqual(engine.state, .running)
    }

    // MARK: - Nudge

    /// The grace minute counts from the first poll that sees the timer stopped.
    func testTheNudgeGraceCountsFromTheFirstPollAfterStopping() {
        engine.start(.flow)
        at(10); typing()
        at(100); engine.stop()
        for second in 100 ... 170 {
            at(Double(second)); typing()
        }
        XCTAssertEqual(nudges, [160])
    }

    func testNudgesRepeatOnlyAfterTheInterval() {
        for second in 60 ... 700 {
            at(Double(second)); typing()
        }
        XCTAssertEqual(nudges, [64, 664], "five typing polls, then once per ten minutes")
    }

    func testAThirtySecondGapResetsTheTypingCount() {
        for second in 100 ... 103 { at(Double(second)); typing() }
        at(104); poll(idle: 30, sinceKey: 30)
        for second in 105 ... 109 { at(Double(second)); typing() }
        XCTAssertEqual(nudges, [109])
    }

    func testAShorterGapKeepsTheTypingCount() {
        for second in 200 ... 203 { at(Double(second)); typing() }
        at(204); poll(idle: 29, sinceKey: 29)
        at(205); typing()
        XCTAssertEqual(nudges, [205])
    }

    func testMouseOnlyNeverNudges() {
        for second in 100 ..< 800 {
            at(Double(second)); poll(idle: 0.2, sinceKey: 500)
        }
        XCTAssertEqual(nudges, [])
    }

    func testTypingDuringARunningFlowNeverNudges() {
        engine.start(.flow)
        for second in 100 ... 800 {
            at(Double(second)); typing()
        }
        XCTAssertEqual(events, [])
        XCTAssertEqual(engine.state, .running)
    }

    /// With resume-on-activity off, an idle pause waits for a press, and typing over it earns
    /// the same nudge as a stopped timer once the grace minute has passed.
    func testDoesAnIdlePauseWithResumeOnActivityOffNudge_YesAfterTheGrace() {
        engine.plan.resumeOnActivity = false
        engine.start(.flow)
        at(100); poll(idle: 70)
        for second in 200 ... 270 {
            at(Double(second)); typing()
        }
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(events, ["pause", "nudge"])
        XCTAssertEqual(nudges, [260])
    }

    // MARK: - The tick

    func testAMissedTickGapKeepsRemainingExact() {
        engine.start(.flow)
        at(600); engine.tick()
        XCTAssertEqual(engine.remainingSec, 900)
        at(600.9); engine.tick()
        XCTAssertEqual(engine.remainingSec, 900)
        at(1200); engine.tick()
        XCTAssertEqual(engine.remainingSec, 300)
        at(1499.5); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1)
        XCTAssertEqual(engine.state, .running)
    }

    func testAMissedTickGapAcrossAPauseKeepsRemainingExact() {
        engine.start(.flow)
        at(100); engine.pause()
        at(700); engine.resume()
        XCTAssertEqual(engine.remainingSec, 1400)
        at(1300); engine.tick()
        XCTAssertEqual(engine.remainingSec, 800)
    }

    func testBreakExpiryAdvancesAndAnnounces() throws {
        engine.start(.shortBreak)
        let id = try openId()
        at(299); engine.tick()
        XCTAssertEqual(engine.remainingSec, 1)
        at(300); engine.tick()
        XCTAssertEqual(engine.phase, .flow)
        XCTAssertEqual(engine.state, .idle)
        XCTAssertEqual(engine.remainingSec, 1500)
        XCTAssertFalse(engine.isTicking)
        XCTAssertEqual(announced, ["short_break>flow:false"])
        XCTAssertEqual(boundaries, 1)
        XCTAssertEqual(phaseEnds, ["short_break@300"])
        XCTAssertEqual(try store.session(id: id)?.endedMs, ms(300))
        XCTAssertEqual(engine.completedFlows, 0)
    }

    func testBreakExpiryWithAutoStartFlowsStartsTheFlow() throws {
        engine.plan.autoStartFlows = true
        engine.start(.shortBreak)
        at(300); engine.tick()
        XCTAssertEqual(engine.phase, .flow)
        XCTAssertEqual(engine.state, .running)
        XCTAssertTrue(engine.isTicking)
        XCTAssertEqual(announced, ["short_break>flow:true"])
        let flow = try XCTUnwrap(try store.openSession())
        XCTAssertEqual(flow.kind, "flow")
        XCTAssertEqual(flow.startedMs, ms(300))
    }

    func testFlowExpiryWithOverrunOffCompletesAndStartsTheBreak() throws {
        engine.plan.allowOverrun = false
        engine.start(.flow)
        let id = try openId()
        at(1500); engine.tick()
        XCTAssertEqual(engine.completedFlows, 1)
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(engine.remainingSec, 300)
        XCTAssertEqual(announced, ["flow>short_break:true"])
        XCTAssertEqual(phaseEnds, ["flow@1500"])
        let flow = try XCTUnwrap(try store.session(id: id))
        XCTAssertEqual(flow.state, ActivityStore.SessionState.done.rawValue)
        XCTAssertEqual(flow.endedMs, ms(1500))
    }

    func testAGapPastAFlowsEndShowsTheWholeOverrunAndRingsOnce() {
        engine.start(.flow)
        at(5000); engine.tick()
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertEqual(engine.remainingSec, -3500)
        at(5010); engine.tick()
        XCTAssertEqual(engine.remainingSec, -3510)
        XCTAssertEqual(announced.count, 1)
        XCTAssertEqual(phaseEnds, ["flow@5000"])
    }

    /// A relaunch ends an expired break at its real end; a live tick after a long gap (a machine
    /// asleep with the app open) ends it at the tick, so the ledger shows a 5000 s break.
    func testDoesALateTickEndABreakAtItsRealEnd_NoAtTheTick() throws {
        engine.start(.shortBreak)
        let id = try openId()
        at(5000); engine.tick()
        XCTAssertEqual(try store.session(id: id)?.endedMs, ms(5000))
        XCTAssertEqual(phaseEnds, ["short_break@5000"])
    }
}
