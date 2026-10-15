import XCTest
@testable import GenesisKit

final class PostureStateMachineTests: XCTestCase {
    private let bad = PostureReading.scored(isBad: true, isClear: false)
    private let good = PostureReading.scored(isBad: false, isClear: true)
    private let band = PostureReading.scored(isBad: false, isClear: false)

    /// A machine that is enabled, calibrated and watching from t = 0, with no resume grace unless asked.
    private func watching(_ timing: PostureTiming = PostureTiming(onsetDelay: 5, resetStreak: 10, resumeGrace: 0)) -> PostureStateMachine {
        var machine = PostureStateMachine(timing: timing)
        machine.setControl(enabled: true, hasBaseline: true, at: 0)
        return machine
    }

    /// Feeds `reading` every `step` seconds from `from` up to `to`, returning every event.
    @discardableResult
    private func feed(_ machine: inout PostureStateMachine, _ reading: PostureReading,
                      from: TimeInterval, to: TimeInterval, step: TimeInterval = 0.25) -> [PostureEvent] {
        var events: [PostureEvent] = []
        var time = from
        while time <= to + 1e-9 {
            events += machine.observe(reading, at: time).events
            time += step
        }
        return events
    }

    func testControlOrderDisabledThenCalibrationThenPauseThenCamera() {
        var machine = PostureStateMachine()
        XCTAssertEqual(machine.state, .disabled)
        machine.setControl(enabled: true, at: 0)
        XCTAssertEqual(machine.state, .needsCalibration)
        machine.setControl(hasBaseline: true, cameraIssue: .some(.noDevice), at: 0)
        XCTAssertEqual(machine.state, .cameraUnavailable(.noDevice))
        machine.setControl(gateReasons: [.screenLocked], at: 0)
        XCTAssertEqual(machine.state, .paused(PosturePause(reasons: [.screenLocked])))
        let until = Date(timeIntervalSince1970: 1000)
        machine.setControl(userPause: .some(PosturePause(reasons: [.user], until: until)), at: 0)
        XCTAssertEqual(machine.state, .paused(PosturePause(reasons: [.screenLocked, .user], until: until)))
        machine.setControl(userPause: .some(nil), gateReasons: [], at: 0)
        XCTAssertEqual(machine.state, .cameraUnavailable(.noDevice))
        // AirPods do not need the camera.
        machine.setControl(usesCamera: false, at: 0)
        XCTAssertEqual(machine.state, .monitoring)
    }

    func testASlouchNeedsTheConfirmationPlusTheOnsetDelay() {
        var machine = watching()
        // confirmBad 2 s + onset 5 s: still monitoring at 6.75 s.
        XCTAssertEqual(feed(&machine, bad, from: 0, to: 6.75), [])
        XCTAssertTrue(machine.isConfirming)
        XCTAssertEqual(machine.state, .monitoring)
        let events = machine.observe(bad, at: 7).events
        XCTAssertEqual(events, [.stateChanged(from: .monitoring, to: .slouching), .slouchStarted])
    }

    func testABriefGoodSpellDoesNotResetAPendingSlouchButAConfirmedOneDoes() {
        var machine = watching()
        feed(&machine, bad, from: 0, to: 3)
        // 0.25 s of good is under confirmGood (0.5 s): the pending slouch survives.
        machine.observe(good, at: 3.25)
        feed(&machine, bad, from: 3.5, to: 7)
        XCTAssertEqual(machine.state, .slouching)

        var other = watching()
        feed(&other, bad, from: 0, to: 3)
        feed(&other, good, from: 3.25, to: 4)
        XCTAssertFalse(other.isConfirming)
        feed(&other, bad, from: 4.25, to: 10)
        XCTAssertEqual(other.state, .monitoring, "the onset restarted at 4.25 s, so 7 s are not up yet")
    }

    func testRecoveryNeedsClearReadingsAndEndsAfterTheResetStreak() {
        var machine = watching()
        feed(&machine, bad, from: 0, to: 7)
        XCTAssertEqual(machine.state, .slouching)
        // The hysteresis band keeps the slouch.
        feed(&machine, band, from: 7.25, to: 9)
        XCTAssertEqual(machine.state, .slouching)
        let toRecovery = feed(&machine, good, from: 9.25, to: 9.75)
        XCTAssertEqual(toRecovery, [.stateChanged(from: .slouching, to: .recovery), .recoveryStarted])
        let toMonitoring = feed(&machine, good, from: 10, to: 19.75)
        XCTAssertEqual(toMonitoring, [.stateChanged(from: .recovery, to: .monitoring), .streakReset])
    }

    func testSlouchingAgainDuringRecoveryReturnsWithoutANewAlert() {
        var machine = watching()
        feed(&machine, bad, from: 0, to: 7)
        feed(&machine, good, from: 7.25, to: 7.75)
        XCTAssertEqual(machine.state, .recovery)
        let events = feed(&machine, bad, from: 8, to: 10)
        XCTAssertEqual(events, [.stateChanged(from: .recovery, to: .slouching)])
    }

    func testRestartingThePostureDropsTheEpisodeAndThePendingTime() {
        var machine = watching()
        feed(&machine, bad, from: 0, to: 7)
        XCTAssertEqual(machine.state, .slouching)
        XCTAssertEqual(machine.restartPosture(at: 7.25), [.stateChanged(from: .slouching, to: .monitoring)])
        feed(&machine, bad, from: 7.5, to: 9)
        XCTAssertEqual(machine.state, .monitoring, "a fresh onset: bad time from before the restart does not count")
        XCTAssertTrue(machine.isConfirming)

        var paused = watching()
        paused.setControl(userPause: .some(PosturePause(reasons: [.user])), at: 0)
        XCTAssertEqual(paused.restartPosture(at: 1), [], "outside a posture phase there is nothing to restart")
    }

    func testNobodyForTheAwayTimeIsAwayAndAPersonComesBackWithGrace() {
        var machine = watching(PostureTiming(onsetDelay: 0, resumeGrace: 3))
        feed(&machine, .absent, from: 0, to: 3.75)
        XCTAssertEqual(machine.state, .monitoring)
        machine.observe(.absent, at: 4)
        XCTAssertEqual(machine.state, .away)
        machine.observe(bad, at: 5)
        XCTAssertEqual(machine.state, .monitoring)
        // The grace (3 s) holds the bad timer until 8 s; confirmBad 2 s then lands at 10 s.
        feed(&machine, bad, from: 5.25, to: 9.75)
        XCTAssertEqual(machine.state, .monitoring)
        machine.observe(bad, at: 10)
        XCTAssertEqual(machine.state, .slouching)
    }

    func testDarkFramesChangeNothing() {
        var machine = watching()
        feed(&machine, .absent, from: 0, to: 2)
        // Dark frames (Dorso #67: low light read as away) never make the user away...
        feed(&machine, .unknown, from: 2.25, to: 30)
        XCTAssertEqual(machine.state, .monitoring)
        // ...and a real reading clears the absence timer.
        machine.observe(good, at: 30.25)
        machine.observe(.absent, at: 31)
        XCTAssertEqual(machine.state, .monitoring)
    }

    func testPauseStopsReadingsAndResumeStartsAfresh() {
        var machine = watching()
        feed(&machine, bad, from: 0, to: 7)
        XCTAssertEqual(machine.state, .slouching)
        let pause = machine.setControl(gateReasons: [.screenLocked], at: 8)
        XCTAssertEqual(pause, [.stateChanged(from: .slouching, to: .paused(PosturePause(reasons: [.screenLocked])))])
        XCTAssertEqual(machine.observe(bad, at: 9).events, [])
        machine.setControl(gateReasons: [], at: 20)
        XCTAssertEqual(machine.state, .monitoring)
        XCTAssertFalse(machine.isConfirming)
    }

    func testCreditGoesToThePreviousActivityAndStopsAtTheGapCap() {
        var machine = watching(PostureTiming(onsetDelay: 0, resumeGrace: 0, maxCreditGap: 10))
        let first = machine.observe(good, at: 1)
        XCTAssertEqual(first.credited, 0)
        let second = machine.observe(good, at: 2)
        XCTAssertEqual(second.credited, 1)
        XCTAssertEqual(second.creditedActivity, .upright)
        let long = machine.observe(good, at: 100)
        XCTAssertEqual(long.credited, 10)
        feed(&machine, bad, from: 100.25, to: 102.25)
        XCTAssertEqual(machine.state, .slouching)
        XCTAssertEqual(machine.observe(bad, at: 103).creditedActivity, .slouching)
    }

    func testCaptureModesFollowThePolicy() {
        let rates = PostureCaptureRates()
        typealias M = PostureStateMachine
        XCTAssertEqual(M.captureMode(state: .paused(PosturePause(reasons: [.user])), confirming: false, policy: .responsive, rates: rates), .off)
        XCTAssertEqual(M.captureMode(state: .disabled, confirming: false, policy: .balanced, rates: rates), .off)
        XCTAssertEqual(M.captureMode(state: .monitoring, confirming: false, policy: .balanced, rates: rates), .continuous(fps: 2))
        XCTAssertEqual(M.captureMode(state: .monitoring, confirming: true, policy: .balanced, rates: rates), .continuous(fps: 10))
        XCTAssertEqual(M.captureMode(state: .recovery, confirming: false, policy: .balanced, rates: rates), .continuous(fps: 10))
        XCTAssertEqual(M.captureMode(state: .monitoring, confirming: false, policy: .batterySaver, rates: rates),
                       .interval(every: 30, frames: 3))
        XCTAssertEqual(M.captureMode(state: .monitoring, confirming: true, policy: .batterySaver, rates: rates), .continuous(fps: 4))
        XCTAssertEqual(M.captureMode(state: .away, confirming: false, policy: .balanced, rates: rates), .continuous(fps: 1))
        XCTAssertEqual(M.captureMode(state: .monitoring, confirming: false, policy: .responsive, rates: rates), .continuous(fps: 10))
    }

    func testReadingsFromSamplesAndScores() throws {
        XCTAssertEqual(PostureReading(sample: PoseSample(time: 0, engine: .visionBody, lowLight: true), score: nil), .unknown)
        XCTAssertEqual(PostureReading(sample: PoseSample(time: 0, engine: .visionBody), score: nil), .absent)
        let sample = postureSample()
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: sample) }))
        let score = PostureScorer().score(PostureMetrics(sample: sample), against: base)
        XCTAssertEqual(PostureReading(sample: sample, score: score), .scored(isBad: false, isClear: true))
    }

    /// Item 36: a reading inside the hysteresis band (neither bad nor clear) holds a pending slouch; only
    /// clear readings for `confirmGood` cancel it.
    func testABandReadingHoldsAPendingSlouch() {
        var machine = watching()
        feed(&machine, bad, from: 0, to: 3)
        feed(&machine, band, from: 3.25, to: 5)
        XCTAssertTrue(machine.isConfirming, "two seconds in the band did not cancel it")
        feed(&machine, bad, from: 5.25, to: 7)
        XCTAssertEqual(machine.state, .slouching)
    }
}

final class PostureHealthTests: XCTestCase {
    func testDrainsAndRefillsAtTheDefaultRates() {
        var health = PostureHealth()
        health.advance(.slouching, seconds: 30)
        XCTAssertEqual(health.value, 0.7, accuracy: 1e-9)
        XCTAssertEqual(health.percent, 70)
        XCTAssertEqual(health.slouchStreak, 30)
        health.advance(.upright, seconds: 5)
        XCTAssertEqual(health.value, 0.85, accuracy: 1e-9)
        XCTAssertEqual(health.slouchStreak, 0)
        health.advance(.idle, seconds: 1000)
        XCTAssertEqual(health.value, 0.85, accuracy: 1e-9)
        health.advance(.upright, seconds: 100)
        XCTAssertEqual(health.value, 1)
        XCTAssertEqual(health.uprightStreak, 105)
        health.advance(.slouching, seconds: 500)
        XCTAssertEqual(health.value, 0)
        XCTAssertEqual(health.uprightStreak, 0)
        XCTAssertEqual(health.bestUprightStreak, 105)
    }
}
