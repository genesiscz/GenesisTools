// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusAttentionTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import UserNotifications
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// The flow-end ding, the banner click, the idle pause and resume, and the nudge.
@MainActor
final class FocusAttentionTests: XCTestCase {
    private var dir: URL!
    private var store: ActivityStore!
    private var engine: PomodoroEngine!
    private var announced: [String] = []
    private var boundaries = 0

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-attention-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = try ActivityStore(path: dir.appendingPathComponent("activity.db").path)
        engine = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 1500, shortBreakSec: 300))
        announced = []
        boundaries = 0
        engine.announcePhaseChange = { [weak self] finished, next, auto in
            self?.announced.append("\(finished.rawValue)>\(next.rawValue):\(auto)")
        }
        engine.onBoundary = { [weak self] in self?.boundaries += 1 }
    }

    override func tearDownWithError() throws {
        engine.stop()
        engine = nil
        store = nil
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Flow end

    /// Observed 2026-09-23: with overrun on (the default) the flow reached 0:00 in silence.
    func testAFlowThatReachesZeroDingsOnceAndTheSkipStaysQuiet() {
        engine.start(.flow, seconds: 0)
        engine.tick()
        XCTAssertEqual(engine.state, .overrun)
        XCTAssertEqual(announced, ["flow>short_break:false"])
        XCTAssertEqual(boundaries, 1, "the boundary also blinks the HUD")

        engine.tick()
        XCTAssertEqual(announced.count, 1, "an overrun announces once, not every second")

        engine.skip()
        XCTAssertEqual(engine.phase, .shortBreak)
        XCTAssertEqual(announced.count, 1, "the skip out of an announced overrun does not ring again")
    }

    func testASkipBeforeZeroStillAnnounces() {
        engine.start(.flow)
        engine.skip()
        XCTAssertEqual(announced, ["flow>short_break:true"])
    }

    func testABreakThatEndsSaysTheFlowIsReady() {
        engine.start(.shortBreak, seconds: 0)
        engine.tick()
        XCTAssertEqual(announced, ["short_break>flow:false"])
        XCTAssertEqual(engine.state, .idle)
    }

    // MARK: - Settings

    func testAttentionSettingsDecodeAndRubbishKeepsTheDefaults() {
        let set = PomodoroPlan.from(appConfig: ["focus": ["timer": [
            "idlePauseSec": 0, "resumeOnActivity": false, "nudgeEverySec": 300,
        ] as [String: Any]] as [String: Any]])
        XCTAssertEqual(set.idlePauseSec, 0)
        XCTAssertFalse(set.resumeOnActivity)
        XCTAssertEqual(set.nudgeEverySec, 300)

        let rubbish = PomodoroPlan.from(appConfig: ["focus": ["timer": [
            "idlePauseSec": -5, "nudgeEverySec": "often",
        ] as [String: Any]] as [String: Any]])
        XCTAssertEqual(rubbish.idlePauseSec, 60)
        XCTAssertTrue(rubbish.resumeOnActivity)
        XCTAssertEqual(rubbish.nudgeEverySec, 600)
    }

    // MARK: - Idle pause and resume

    func testAnIdleFlowPausesItselfBackdatedToTheLastInput() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        _ = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                         plannedSec: 1500, startedMs: now - 600_000,
                                         state: ActivityStore.SessionState.running.rawValue,
                                         cycleIndex: 0))
        engine.resumeOpenSessionIfAny()
        XCTAssertEqual(engine.state, .running)
        let watch = FocusIdleWatch(engine: engine)
        var events: [String] = []
        watch.onAutoPause = { events.append("pause") }
        watch.onAutoResume = { events.append("resume") }

        watch.step(now: Date(), idleSec: 120, sinceKeySec: 120)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .idle)
        XCTAssertEqual(events, ["pause"])
        // 600 s since the start, the last 120 of them away: 480 s used, 1020 s left.
        XCTAssertTrue((1019 ... 1021).contains(engine.remainingSec), "got \(engine.remainingSec)")
        let session = try XCTUnwrap(try store.openSession())
        let pause = try XCTUnwrap(try store.pauses(sessionId: session.id).last)
        XCTAssertEqual(pause.reason, "idle")
        XCTAssertLessThan(abs(pause.startedMs - (now - 120_000)), 2_000)

        watch.step(now: Date(), idleSec: 0.4, sinceKeySec: 0.4)
        XCTAssertEqual(engine.state, .running)
        XCTAssertNil(engine.pauseReason)
        XCTAssertEqual(events, ["pause", "resume"])
        engine.tick()
        XCTAssertTrue((1019 ... 1021).contains(engine.remainingSec), "the time away is handed back, got \(engine.remainingSec)")
    }

    func testActivityNeverResumesAPauseYouPressed() {
        engine.start(.flow)
        engine.pause()
        let watch = FocusIdleWatch(engine: engine)
        watch.step(now: Date(), idleSec: 0.2, sinceKeySec: 0.2)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.pauseReason, .manual)
    }

    func testResumeOnActivityOffLeavesTheIdlePause() {
        engine.plan.resumeOnActivity = false
        engine.start(.flow)
        let watch = FocusIdleWatch(engine: engine)
        watch.step(now: Date(), idleSec: 61, sinceKeySec: 61)
        watch.step(now: Date(), idleSec: 0.2, sinceKeySec: 0.2)
        XCTAssertEqual(engine.state, .paused)
    }

    func testBreaksNeverPauseForIdleness() {
        engine.start(.shortBreak)
        let watch = FocusIdleWatch(engine: engine)
        watch.step(now: Date(), idleSec: 900, sinceKeySec: 900)
        XCTAssertEqual(engine.state, .running)
    }

    func testIdlePauseOffLeavesTheFlowRunning() {
        engine.plan.idlePauseSec = 0
        engine.start(.flow)
        let watch = FocusIdleWatch(engine: engine)
        watch.step(now: Date(), idleSec: 3_600, sinceKeySec: 3_600)
        XCTAssertEqual(engine.state, .running)
    }

    // MARK: - Nudge

    private func type(_ watch: FocusIdleWatch, from start: Date, seconds: Int) {
        for second in 0 ..< seconds {
            watch.step(now: start.addingTimeInterval(TimeInterval(second)), idleSec: 0.3, sinceKeySec: 0.3)
        }
    }

    func testTypingWhileStoppedNudgesOnceThenWaitsForTheInterval() {
        let base = Date()
        let watch = FocusIdleWatch(engine: engine, now: base.addingTimeInterval(-120))
        var nudges = 0
        watch.onNudge = { nudges += 1 }

        type(watch, from: base, seconds: 4)
        XCTAssertEqual(nudges, 0, "a few keys are not starting to work")
        type(watch, from: base.addingTimeInterval(4), seconds: 30)
        XCTAssertEqual(nudges, 1, "one nudge, then quiet while you keep typing")
        type(watch, from: base.addingTimeInterval(700), seconds: 5)
        XCTAssertEqual(nudges, 2, "the next one only after the interval")
    }

    func testNoNudgeInTheFirstMinuteAfterStopping() {
        let base = Date()
        let watch = FocusIdleWatch(engine: engine, now: base)
        var nudges = 0
        watch.onNudge = { nudges += 1 }
        type(watch, from: base, seconds: 50)
        XCTAssertEqual(nudges, 0)
        type(watch, from: base.addingTimeInterval(61), seconds: 1)
        XCTAssertEqual(nudges, 1)
    }

    func testAManualPauseNudgesButARunningFlowNever() {
        let base = Date()
        engine.start(.flow)
        let watch = FocusIdleWatch(engine: engine, now: base.addingTimeInterval(-120))
        var nudges = 0
        watch.onNudge = { nudges += 1 }
        type(watch, from: base, seconds: 10)
        XCTAssertEqual(nudges, 0, "a running flow is the goal, not a reason to nudge")
        engine.pause()
        type(watch, from: base.addingTimeInterval(100), seconds: 10)
        XCTAssertEqual(nudges, 0, "the first minute after a pause is quiet too")
        type(watch, from: base.addingTimeInterval(170), seconds: 5)
        XCTAssertEqual(nudges, 1)
    }

    func testMouseAloneAndNudgeOffNeverNudge() {
        let base = Date()
        let watch = FocusIdleWatch(engine: engine, now: base.addingTimeInterval(-120))
        var nudges = 0
        watch.onNudge = { nudges += 1 }
        for second in 0 ..< 20 {
            watch.step(now: base.addingTimeInterval(TimeInterval(second)), idleSec: 0.3, sinceKeySec: 300)
        }
        XCTAssertEqual(nudges, 0, "moving the mouse is not typing")
        engine.plan.nudgeEverySec = 0
        type(watch, from: base.addingTimeInterval(100), seconds: 20)
        XCTAssertEqual(nudges, 0)
    }

    // MARK: - Sound and banner

    func testTheNudgeChimeIsAQuietValidWav() {
        let rate = 8_000
        let wav = FocusChime.nudgeWAV(sampleRate: rate)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(wav.count, 44 + Int(Double(rate) * 1.4) * 2)
        var peak = 0
        wav.dropFirst(44).withUnsafeBytes { raw in
            for offset in stride(from: 0, to: raw.count, by: 2) {
                let value = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: Int16.self))
                peak = max(peak, abs(Int(value)))
            }
        }
        XCTAssertGreaterThan(peak, Int(Double(Int16.max) * 0.05), "a silent chime is not a nudge")
        XCTAssertLessThan(peak, Int(Double(Int16.max) * 0.35), "a nudge, not an alarm")
    }

    #if canImport(Genesis)
    func testClickingAPhaseBannerBringsTheTimerForward() {
        let router = QaNotificationRouter.shared
        var taps = 0
        router.focusTapHandler = { taps += 1 }
        defer { router.focusTapHandler = nil }
        let info: [AnyHashable: Any] = [QaNotificationIDs.kindKey: FocusChime.notificationKind]
        router.handleAction(actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: info)
        XCTAssertEqual(taps, 1)
        router.handleAction(actionIdentifier: UNNotificationDismissActionIdentifier, userInfo: info)
        XCTAssertEqual(taps, 1, "swiping the banner away is not a request to see the timer")
    }
    #endif
}
