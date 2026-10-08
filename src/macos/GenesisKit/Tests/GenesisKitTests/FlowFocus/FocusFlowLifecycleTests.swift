// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusFlowLifecycleTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// The flow's clock across pauses, idle, resumes and relaunches, driven by a movable clock.
///
/// Every scenario here is one a person hits by walking away from the desk and coming back.
/// `FocusIdleWatch.step` takes its idle seconds as values and the engine reads `clock`, so no
/// test sleeps and no test touches the real keyboard.
@MainActor
final class FocusFlowLifecycleTests: XCTestCase {
    private var dir: URL!
    private var store: ActivityStore!
    private var engine: PomodoroEngine!
    private var watch: FocusIdleWatch!
    private var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var events: [String] = []
    private var announced: [String] = []

    private var t0: Date { Date(timeIntervalSince1970: 1_800_000_000) }

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-flow-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = try ActivityStore(path: dir.appendingPathComponent("activity.db").path)
        now = t0
        events = []
        announced = []
        engine = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 1500, shortBreakSec: 300))
        engine.clock = { [unowned self] in self.now }
        engine.announcePhaseChange = { [weak self] finished, next, auto in
            self?.announced.append("\(finished.rawValue)>\(next.rawValue):\(auto)")
        }
        watch = makeWatch()
    }

    override func tearDownWithError() throws {
        engine.stop()
        engine = nil
        watch = nil
        store = nil
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Helpers

    private func makeWatch() -> FocusIdleWatch {
        let watch = FocusIdleWatch(engine: engine, now: now)
        watch.onAutoPause = { [weak self] in self?.events.append("pause") }
        watch.onAutoResume = { [weak self] in self?.events.append("resume") }
        watch.onNudge = { [weak self] in self?.events.append("nudge") }
        return watch
    }

    /// Moves the clock to `seconds` after t0.
    private func at(_ seconds: TimeInterval) {
        now = t0.addingTimeInterval(seconds)
    }

    /// One idle-watch poll at the current clock.
    private func poll(idle: Double, sinceKey: Double? = nil) {
        watch.step(now: now, idleSec: idle, sinceKeySec: sinceKey ?? idle)
    }

    private func ms(_ seconds: TimeInterval) -> Int64 {
        Int64(t0.addingTimeInterval(seconds).timeIntervalSince1970 * 1000)
    }

    /// Seeds the ledger as if a previous process died mid-flow, then relaunches the engine on it.
    private func relaunch(startedAt start: TimeInterval, pausedAt pause: TimeInterval?, reason: ActivityStore.PauseReason = .idle) throws {
        let id = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                              plannedSec: 1500, startedMs: ms(start),
                                              state: (pause == nil ? ActivityStore.SessionState.running : .paused).rawValue,
                                              cycleIndex: 0))
        if let pause {
            _ = try store.recordPause(sessionId: id, startedMs: ms(pause), endedMs: nil, reason: reason)
        }
        engine.resumeOpenSessionIfAny()
    }

    // MARK: - The 2026-09-24 12:47 frozen clock

    /// Relaunched while idle-paused, then input came back: the clock must move again. It showed
    /// the pause button over a frozen "+712:18" because nothing started the ticker.
    func testARestoredIdlePauseTicksAgainAfterInputReturns() throws {
        at(2000)
        try relaunch(startedAt: 0, pausedAt: 1900)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .idle)

        poll(idle: 0.5)
        XCTAssertEqual(events, ["resume"])
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertTrue(engine.isTicking, "a resumed flow without a ticker shows a frozen clock")

        let before = engine.remainingSec
        at(2010)
        engine.tick()
        XCTAssertEqual(engine.remainingSec, before - 10, "ten seconds of work are ten seconds of overrun")
        let pause = try XCTUnwrap(try store.pauses(sessionId: XCTUnwrap(try store.openSession()).id).last)
        XCTAssertNotNil(pause.endedMs, "the resume closes the pause it ended")
    }

    /// Same relaunch, resumed by hand with the play button.
    func testARestoredPauseResumedByHandTicks() throws {
        at(600)
        try relaunch(startedAt: 0, pausedAt: 500, reason: .manual)
        XCTAssertFalse(engine.isTicking)
        engine.resume()
        XCTAssertEqual(engine.state, .running)
        XCTAssertTrue(engine.isTicking)
        let before = engine.remainingSec
        at(630)
        engine.tick()
        XCTAssertEqual(engine.remainingSec, before - 30)
    }

    func testARelaunchWhileRunningTicksAtOnce() throws {
        at(300)
        try relaunch(startedAt: 0, pausedAt: nil)
        XCTAssertEqual(engine.state, .running)
        XCTAssertTrue(engine.isTicking)
        XCTAssertEqual(engine.remainingSec, 1200)
    }

    /// Still away after the relaunch: stays paused, says nothing.
    func testARestoredIdlePauseWaitsForInput() throws {
        at(2000)
        try relaunch(startedAt: 0, pausedAt: 1900)
        poll(idle: 90)
        poll(idle: 91)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(events, [])
    }

    // MARK: - Repeated idle cycles

    /// Away, back, away, back: every transition pauses or resumes and signals, and neither
    /// stretch of absence is charged to the flow.
    func testEveryIdleCyclePausesResumesAndSignals() throws {
        engine.start(.flow)
        at(100); poll(idle: 61)                  // away since t0 + 39
        XCTAssertEqual(engine.state, .paused)
        at(200); poll(idle: 0.5)                 // back at t0 + 200
        XCTAssertEqual(engine.state, .running)
        at(260); poll(idle: 3)                   // a short thought is not absence
        XCTAssertEqual(engine.state, .running)
        at(330); poll(idle: 65)                  // away since t0 + 265
        XCTAssertEqual(engine.state, .paused)
        at(400); poll(idle: 0.2)                 // back at t0 + 400
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(events, ["pause", "resume", "pause", "resume"])

        engine.tick()
        // 400 s of wall clock, minus 161 s and 135 s away.
        XCTAssertEqual(engine.remainingSec, 1500 - 104)

        let pauses = try store.pauses(sessionId: XCTUnwrap(try store.openSession()).id)
        XCTAssertEqual(pauses.map(\.reason), ["idle", "idle"])
        XCTAssertEqual(pauses.map(\.startedMs), [ms(39), ms(265)])
        XCTAssertEqual(pauses.map(\.endedMs), [ms(200), ms(400)])
    }

    /// An overrun keeps counting after each return, from where it stood when you left.
    func testAnOverrunFlowExcludesIdleAndKeepsCountingAfterResume() throws {
        engine.start(.flow)
        at(1600); engine.tick()
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertEqual(engine.remainingSec, -100)

        at(1700); poll(idle: 120)                // away since t0 + 1580
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, -80, "the frozen clock shows the moment you left")

        at(1800); poll(idle: 0.4)
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertEqual(engine.remainingSec, -80)
        at(1820); engine.tick()
        XCTAssertEqual(engine.remainingSec, -100)
        XCTAssertEqual(announced.count, 1, "one ding at zero, none on the resumes")
    }

    // MARK: - Thresholds and edges

    func testIdleThresholdIsInclusive() {
        engine.start(.flow)
        at(100); poll(idle: 59.9)
        XCTAssertEqual(engine.state, .running)
        poll(idle: 60)
        XCTAssertEqual(engine.state, .paused)
    }

    /// Idle for longer than the flow has existed: the pause starts at the flow's start, never
    /// before it, so the clock cannot go above the planned length.
    func testTheBackdateNeverReachesBeforeTheFlowStarted() {
        engine.start(.flow)
        at(30); poll(idle: 600)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.remainingSec, 1500)
    }

    func testTheWatchSignalsOncePerTransition() {
        engine.start(.flow)
        at(100); poll(idle: 70)
        at(101); poll(idle: 71)
        at(200); poll(idle: 0.1)
        at(201); poll(idle: 0.2)
        XCTAssertEqual(events, ["pause", "resume"])
    }

    func testShortGapsAfterAResumeDoNotPauseAgain() {
        engine.start(.flow)
        at(100); poll(idle: 70)
        at(200); poll(idle: 0.1)
        for (second, idle) in [(205.0, 5.0), (230, 30), (259, 59)] {
            at(second); poll(idle: idle)
        }
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(events, ["pause", "resume"])
    }

    func testAPausedFlowDoesNotCount() {
        engine.start(.flow)
        at(100); engine.pause()
        let frozen = engine.remainingSec
        at(500); engine.tick()
        XCTAssertEqual(engine.remainingSec, frozen)
    }

    func testEveryResumeLeavesATicker() {
        engine.start(.flow)
        engine.pause()
        engine.resume()
        XCTAssertTrue(engine.isTicking)
        at(100); poll(idle: 80)
        at(200); poll(idle: 0.3)
        XCTAssertTrue(engine.isTicking)
    }

    /// A pause you pressed is yours: no amount of absence or input changes it.
    func testAPressedPauseIgnoresIdleAndInput() {
        engine.start(.flow)
        at(50); engine.pause()
        at(5000); poll(idle: 4000)
        at(5001); poll(idle: 0.1, sinceKey: 30)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .manual)
        XCTAssertFalse(events.contains("resume"))
    }

    func testResumeOnActivityOffKeepsTheIdlePauseUntilPressed() {
        engine.plan.resumeOnActivity = false
        engine.start(.flow)
        at(100); poll(idle: 70)
        at(200); poll(idle: 0.1)
        XCTAssertEqual(engine.state, .paused)
        engine.resume()
        XCTAssertEqual(engine.state, .running)
        XCTAssertTrue(engine.isTicking)
    }

    // MARK: - Ending from an idle pause

    func testStoppingDuringAnIdlePauseClosesItAndStopsTheClock() throws {
        engine.start(.flow)
        let id = try XCTUnwrap(try store.openSession()).id
        at(100); poll(idle: 70)
        at(150); engine.stop()
        XCTAssertEqual(engine.state, .idle)
        XCTAssertFalse(engine.isTicking)
        let pauses = try store.pauses(sessionId: id)
        XCTAssertEqual(pauses.count, 1)
        XCTAssertEqual(pauses.first?.endedMs, ms(150))
        XCTAssertNil(try store.openSession())
    }

    func testSkippingAnIdlePausedOverrunStaysQuietAndStartsTheBreak() {
        engine.start(.flow)
        at(1600); engine.tick()
        XCTAssertEqual(announced.count, 1)
        at(1700); poll(idle: 90)
        engine.skip()
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(engine.state, .running, "breaks start by themselves")
        XCTAssertEqual(announced.count, 1, "the skip after an announced overrun does not ring again")
    }

    func testABreakNeverPausesForIdleness() {
        engine.start(.shortBreak)
        at(200); poll(idle: 190)
        XCTAssertEqual(engine.state, .running)
        XCTAssertEqual(events, [])
    }

    // MARK: - Nudges around idle pauses

    /// Typing while the flow sits idle-paused resumes it; it is never a "start a flow" nudge.
    func testTypingDuringAnIdlePauseResumesInsteadOfNudging() {
        engine.start(.flow)
        at(100); poll(idle: 70)
        for second in 0 ..< 10 {
            at(300 + Double(second)); poll(idle: 0.3, sinceKey: 0.3)
        }
        XCTAssertEqual(events, ["pause", "resume"])
    }
}
