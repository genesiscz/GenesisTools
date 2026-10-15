import XCTest
@testable import GenesisKit

final class CameraLogicTests: XCTestCase {
    @MainActor
    func testRestartingActivityGateRefreshesTheSavedCamera() {
        let gate = ActivityGate()
        gate.observeCamera(uniqueID: "missing-fixture-camera")
        gate.start()
        gate.set(.cameraInUse, true) // Last observation before stopping.
        gate.stop()
        XCTAssertTrue(gate.reasons.contains(.cameraInUse))
        gate.start() // The saved device is no longer present/in use.
        defer { gate.stop() }
        XCTAssertFalse(gate.reasons.contains(.cameraInUse))
    }

    @MainActor
    func testRestartReconcilesPauseReasonsMissedWhileStopped() {
        let transient: Set<ActivityPauseReason> = [.screensAsleep, .screenSaver, .sessionInactive]
        var current = transient
        let gate = ActivityGate(readEventReasons: { _ in current })
        gate.start()
        XCTAssertTrue(transient.isSubset(of: gate.reasons))
        gate.set(.user, true)
        gate.set(.systemSleep, true)
        gate.stop()
        // Resume notifications occur while there are no observers.
        current = []
        gate.start()
        XCTAssertTrue(gate.reasons.isDisjoint(with: transient.union([.systemSleep])))
        XCTAssertTrue(gate.reasons.contains(.user), "reconciliation only owns the system event reasons")
        gate.stop()
        // A restart while the conditions still apply must retain the pause.
        current = transient
        gate.start()
        defer { gate.stop() }
        XCTAssertTrue(transient.isSubset(of: gate.reasons))
    }

    func testWarmupWaitsForTheMinimumThenForStableBrightness() {
        var warmup = CameraWarmup()
        var time = 0.0
        var settledAt: Double?
        // Brightness climbs 0.025 a frame (faster than the 0.02 tolerance) until 0.73 s, then holds.
        while time < 2, settledAt == nil {
            let luma = min(0.6, 0.05 + time * 0.75)
            if warmup.settled(at: time, luma: luma, adjustingExposure: false) { settledAt = time }
            time += 1.0 / 30
        }
        let at = try? XCTUnwrap(settledAt)
        XCTAssertNotNil(at)
        XCTAssertGreaterThanOrEqual(at ?? 0, 0.7)
        XCTAssertLessThan(at ?? 9, 0.85)
    }

    func testWarmupGivesUpAtItsCap() {
        var warmup = CameraWarmup()
        var time = 0.0
        while !warmup.settled(at: time, luma: 0.5, adjustingExposure: true) { time += 0.1 }
        XCTAssertEqual(time, 1.5, accuracy: 0.11)
    }

    func testThrottleKeepsTheAskedRateWithJitterSlack() {
        var throttle = FrameThrottle(fps: 2)
        let kept = stride(from: 0.0, to: 2.9, by: 1.0 / 30).filter { throttle.admit($0) }
        XCTAssertEqual(kept.count, 6)
        var exact = FrameThrottle(fps: 10)
        XCTAssertEqual([0, 0.098, 0.199, 0.297].filter { exact.admit($0) }.count, 4)
    }

    func testFrameDurationPicksTheSlowestSupportedRate() {
        XCTAssertEqual(try XCTUnwrap(CameraFrameSource.frameDuration(for: 2, ranges: [(1, 30)])), 0.5, accuracy: 1e-12)
        // A format that cannot go below 15 fps runs at 15 and the throttle drops the rest.
        XCTAssertEqual(try XCTUnwrap(CameraFrameSource.frameDuration(for: 2, ranges: [(15, 30)])), 1.0 / 15, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(CameraFrameSource.frameDuration(for: 2, ranges: [(15, 30), (5, 5)])), 0.2, accuracy: 1e-12)
        XCTAssertNil(CameraFrameSource.frameDuration(for: 60, ranges: [(1, 30)]))
        XCTAssertNil(CameraFrameSource.frameDuration(for: 0, ranges: [(1, 30)]))
    }

    func testCameraSelectionStorage() {
        XCTAssertEqual(CameraSelection(storageValue: nil), .systemDefault)
        XCTAssertEqual(CameraSelection(storageValue: "default"), .systemDefault)
        XCTAssertEqual(CameraSelection(storageValue: "0x1234"), .device(id: "0x1234"))
        XCTAssertEqual(CameraSelection.device(id: "0x1234").storageValue, "0x1234")
    }

    func testSourceStatesMapToPostureIssues() {
        XCTAssertNil(CameraSourceState.waiting.issue)
        XCTAssertNil(CameraSourceState.running.issue)
        XCTAssertEqual(CameraSourceState.unauthorized.issue, .unauthorized)
        XCTAssertEqual(CameraSourceState.noDevice.issue, .noDevice)
    }

    func testLaptopOnlyIsOneBuiltInScreen() {
        XCTAssertTrue(ActivityGate.isLaptopOnly(builtIn: [true]))
        XCTAssertFalse(ActivityGate.isLaptopOnly(builtIn: [false]))
        XCTAssertFalse(ActivityGate.isLaptopOnly(builtIn: [true, false]))
        XCTAssertFalse(ActivityGate.isLaptopOnly(builtIn: []))
    }

    /// Never calls the real request: macOS judges the responsible process (the terminal that ran
    /// `swift test`), which has no camera usage description, and ends the test run.
    func testCameraRequestNeverAsksWithoutAUsageDescription() async {
        final class Spy: @unchecked Sendable { var asked = 0 }
        let spy = Spy()
        let ask: () async -> Bool = { spy.asked += 1; return true }
        let noKey = await CameraAuthorization.request(status: .notDetermined, hasUsageDescription: false, ask: ask)
        XCTAssertFalse(noKey)
        XCTAssertEqual(spy.asked, 0)
        let denied = await CameraAuthorization.request(status: .denied, hasUsageDescription: true, ask: ask)
        XCTAssertFalse(denied)
        XCTAssertEqual(spy.asked, 0)
        let granted = await CameraAuthorization.request(status: .authorized, hasUsageDescription: false, ask: ask)
        XCTAssertTrue(granted)
        XCTAssertEqual(spy.asked, 0)
        let asked = await CameraAuthorization.request(status: .notDetermined, hasUsageDescription: true, ask: ask)
        XCTAssertTrue(asked)
        XCTAssertEqual(spy.asked, 1)
    }

    func testHeadphonesNeverStartWithoutAUsageDescriptionOrAfterARefusal() {
        XCTAssertFalse(HeadphoneMotionEngine.canStart(hasUsageDescription: false, authorization: .authorized, available: true))
        XCTAssertFalse(HeadphoneMotionEngine.canStart(hasUsageDescription: true, authorization: .denied, available: true))
        XCTAssertFalse(HeadphoneMotionEngine.canStart(hasUsageDescription: true, authorization: .authorized, available: false))
        XCTAssertTrue(HeadphoneMotionEngine.canStart(hasUsageDescription: true, authorization: .notDetermined, available: true))
    }

    func testHeadphoneSamplesFlipPitchAndAreThrottled() {
        let engine = HeadphoneMotionEngine(sampleInterval: 0.5)
        final class Box: @unchecked Sendable { var samples: [PoseSample] = [] }
        let box = Box()
        engine.onSample = { box.samples.append($0) }
        // Core Motion's pitch falls when the head nods down; the sample carries it positive down.
        for index in 0..<24 { engine.receive(attitudePitch: -0.2, at: Double(index) * 0.04) }
        let samples = box.samples
        XCTAssertEqual(samples.count, 2, "25 Hz for 0.92 s gives two samples at 0.5 s")
        XCTAssertEqual(samples.first?.headphonePitch, 0.2)
        XCTAssertEqual(engine.latestPitch, 0.2)
        XCTAssertTrue(engine.isConnected, "motion data means a bud is in")
    }

    func testAFullScreenWindowIsANormalWindowOfTheAppTheSizeOfAScreen() {
        let screens = [CGSize(width: 1512, height: 982), CGSize(width: 2560, height: 1440)]
        let app: pid_t = 42
        XCTAssertTrue(ActivityGate.coversScreen(windows: [(app, 0, CGRect(x: 1512, y: 0, width: 2560, height: 1440))],
                                                pid: app, screens: screens))
        XCTAssertFalse(ActivityGate.coversScreen(windows: [(app, 0, CGRect(x: 0, y: 25, width: 1512, height: 957))],
                                                 pid: app, screens: screens), "a zoomed window leaves the menu bar")
        XCTAssertFalse(ActivityGate.coversScreen(windows: [(7, 0, CGRect(x: 0, y: 0, width: 1512, height: 982))],
                                                 pid: app, screens: screens), "another app's window")
        XCTAssertFalse(ActivityGate.coversScreen(windows: [(app, 25, CGRect(x: 0, y: 0, width: 1512, height: 982))],
                                                 pid: app, screens: screens), "an overlay above the normal level")
        XCTAssertEqual(ActivityPauseReason.fullScreenApp.title, "Full-screen app")
    }

    /// Item 37: stopping without the in-ear monitor forgets the buds, so a later Auto does not trust a
    /// stale "connected".
    func testStoppingTheHeadphonesForgetsTheConnection() {
        let engine = HeadphoneMotionEngine(sampleInterval: 0.5)
        engine.receive(attitudePitch: 0, at: 0)
        XCTAssertTrue(engine.isConnected)
        engine.stop(keepConnectionMonitor: true)
        XCTAssertTrue(engine.isConnected, "the in-ear monitor still runs")
        engine.stop()
        XCTAssertFalse(engine.isConnected)
        XCTAssertNil(engine.latestPitch)
    }
}
