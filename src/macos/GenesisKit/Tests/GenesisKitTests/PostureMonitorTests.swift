import Combine
import XCTest
@testable import GenesisKit
@testable import GenesisKitPosture

/// Records the modes a monitor asks for, instead of a camera.
final class RecordingCamera: CameraModeControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [CameraCaptureMode] = []
    private var held: CameraCaptureMode?
    /// Signalled when `setMode` reaches the held mode; it waits for `release` before recording it.
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    var modes: [CameraCaptureMode] { lock.withLock { recorded } }

    /// Makes the next `setMode(mode)` stall until `release` is signalled (a slow camera queue).
    func hold(_ mode: CameraCaptureMode) { lock.withLock { held = mode } }

    func setMode(_ mode: CameraCaptureMode) {
        let stall = lock.withLock { () -> Bool in
            guard held == mode else { return false }
            held = nil
            return true
        }
        if stall {
            entered.signal()
            // A test that never releases fails on its own assertions instead of hanging the run.
            _ = release.wait(timeout: .now() + 10)
        }
        lock.withLock { recorded.append(mode) }
    }
}

/// A camera engine for tests: never called, since samples go in through `ingest`.
final class NoEngine: FramePoseEngine {
    let kind: PoseEngineKind = .visionBody
    let usesCamera = true
    func analyze(_ frame: CameraFrame) -> PoseSample? { nil }
}

final class ClockBox: @unchecked Sendable {
    var now: TimeInterval = 0
}

@MainActor
final class PostureMonitorTests: XCTestCase {
    private func makeMonitor(history: PostureHistoryStore? = nil, policy: PostureFrameRatePolicy = .balanced)
        -> (PostureMonitor, RecordingCamera, ClockBox) {
        let camera = RecordingCamera()
        let clock = ClockBox()
        let configuration = PostureMonitor.Configuration(
            timing: PostureTiming(confirmBad: 1, confirmGood: 0.5, onsetDelay: 1, resetStreak: 2, resumeGrace: 0),
            policy: policy)
        let monitor = PostureMonitor(configuration: configuration, camera: nil, cameraControl: camera, engine: NoEngine(),
                                     history: history, clock: { clock.now }, wallClock: { Date(timeIntervalSince1970: 1_800_000_000 + clock.now) })
        return (monitor, camera, clock)
    }

    private func baseline() throws -> PostureBaseline {
        try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: postureSample()) }))
    }

    /// Lets the main queue run the monitor's publishes.
    private func settle() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    private func feed(_ monitor: PostureMonitor, clock: ClockBox, noseY: Double, from: TimeInterval, to: TimeInterval) {
        var time = from
        while time <= to + 1e-9 {
            clock.now = time
            monitor.ingest(postureSample(noseY: noseY, time: time))
            time += 0.25
        }
        settle()
    }

    func testCalibrationGatesTheCameraAndASlouchRaisesTheRate() throws {
        let (monitor, camera, clock) = makeMonitor()
        var events: [PostureEvent] = []
        monitor.onEvent = { events.append($0) }
        monitor.enable()
        settle()
        XCTAssertEqual(monitor.state, .needsCalibration)
        XCTAssertEqual(camera.modes, [.off])

        monitor.setBaseline(try baseline())
        settle()
        XCTAssertEqual(monitor.state, .monitoring)
        XCTAssertEqual(camera.modes.last, .continuous(fps: 2))

        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 1)
        // The smoother (median of the last second) turns bad at 1.75 s.
        feed(monitor, clock: clock, noseY: 0.6, from: 1.25, to: 2)
        XCTAssertEqual(monitor.state, .monitoring)
        XCTAssertEqual(camera.modes.last, .continuous(fps: 10), "a pending slouch raises the rate")
        // confirmBad 1 s + onset 1 s after 1.75 s.
        feed(monitor, clock: clock, noseY: 0.6, from: 2.25, to: 4)
        XCTAssertEqual(monitor.state, .slouching)
        XCTAssertEqual(monitor.worst, .headDrop)
        XCTAssertGreaterThan(monitor.strength, 0)
        XCTAssertTrue(events.contains(.slouchStarted))
        XCTAssertLessThan(monitor.health.value, 1)

        feed(monitor, clock: clock, noseY: 0.45, from: 4.25, to: 5.5)
        XCTAssertEqual(monitor.state, .recovery)
        XCTAssertEqual(monitor.strength, 0)
        feed(monitor, clock: clock, noseY: 0.45, from: 5.75, to: 8)
        XCTAssertEqual(monitor.state, .monitoring)
        XCTAssertEqual(camera.modes.last, .continuous(fps: 2))
        XCTAssertEqual(events.filter { $0 == .slouchStarted }.count, 1)
    }

    func testAPauseTurnsTheCameraOffAndAResumeTurnsItBackOn() throws {
        let (monitor, camera, _) = makeMonitor(policy: .batterySaver)
        monitor.setBaseline(try baseline())
        monitor.enable()
        settle()
        XCTAssertEqual(camera.modes.last, .interval(every: 30, frames: 3))
        monitor.pause(for: 600)
        settle()
        guard case let .paused(pause) = monitor.state else { return XCTFail("\(monitor.state)") }
        XCTAssertEqual(pause.reasons, [.user])
        XCTAssertNotNil(pause.until)
        XCTAssertEqual(camera.modes.last, .off)
        monitor.resume()
        settle()
        XCTAssertEqual(monitor.state, .monitoring)
        XCTAssertEqual(camera.modes.last, .interval(every: 30, frames: 3))
    }

    func testOnlyTheChosenGateReasonsPause() throws {
        let (monitor, camera, _) = makeMonitor()
        monitor.setBaseline(try baseline())
        monitor.enable()
        monitor.gateChanged([.onBattery])
        settle()
        XCTAssertEqual(monitor.state, .monitoring, "battery is opt-in")
        monitor.gateChanged([.onBattery, .screenLocked])
        settle()
        XCTAssertEqual(monitor.state, .paused(PosturePause(reasons: [.screenLocked])))
        XCTAssertEqual(camera.modes.last, .off)
        monitor.configuration.pauseReasons.insert(.onBattery)
        monitor.gateChanged([.onBattery])
        settle()
        XCTAssertEqual(monitor.state, .paused(PosturePause(reasons: [.onBattery])))
    }

    func testTheMainActorHearsOnlyChanges() throws {
        let (monitor, _, clock) = makeMonitor()
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 0.5)
        var publishes = 0
        let subscription = monitor.objectWillChange.sink { publishes += 1 }
        defer { subscription.cancel() }
        // Forty upright readings at full health change nothing on screen.
        feed(monitor, clock: clock, noseY: 0.45, from: 0.75, to: 10.5)
        XCTAssertEqual(publishes, 0)
        // The skeleton feed stays empty while nobody watches it.
        XCTAssertNil(monitor.feed.sample)
        monitor.feed.isWatched = true
        feed(monitor, clock: clock, noseY: 0.45, from: 10.75, to: 11)
        XCTAssertNotNil(monitor.feed.sample)
        XCTAssertNotNil(monitor.feed.lastGood)
        XCTAssertEqual(monitor.feed.score?.isClear, true, "a debug view reads each fault's drift from the feed")
        XCTAssertEqual(publishes, 0, "the feed is its own object")
    }

    func testHeadphonesNeedAPitchBaseline() throws {
        XCTAssertFalse(PostureMonitor.covers(nil, headphones: false))
        let camera = try baseline()
        XCTAssertTrue(PostureMonitor.covers(camera, headphones: false))
        XCTAssertFalse(PostureMonitor.covers(camera, headphones: true))
        var both = camera
        both.metrics[.headphonePitch] = 0
        XCTAssertTrue(PostureMonitor.covers(both, headphones: true))
    }

    func testConcurrentHistorySwapsPreserveCreditedRows() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("posture-swap-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = PostureHistoryStore(directory: directory.appendingPathComponent("first"))
        let second = PostureHistoryStore(directory: directory.appendingPathComponent("second"))
        let now = Date(timeIntervalSince1970: 1_800_000_010)
        let clock = ClockBox()
        let core = PostureCore(configuration: .init(timing: .init(resumeGrace: 0)),
                               engine: NoEngine(), camera: nil, history: first, feed: PoseSampleFeed(),
                               wallClock: {
                                   clock.now += 1 // Only ingest advances this clock, under the core's lock.
                                   return now.addingTimeInterval(clock.now)
                               })
        core.setBaseline(try baseline(), at: 0)
        core.control(enabled: true, hasBaseline: true, userPause: nil, gateReasons: [],
                     cameraIssue: nil, usesCamera: true, at: 0)
        core.ingest(postureSample(time: 0))
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            for index in 1...400 { core.ingest(postureSample(time: Double(index))) }
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            for index in 0..<400 { core.setHistory(index.isMultiple(of: 2) ? second : first) }
            group.leave()
        }
        XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
        core.flushHistory()
        first.flush()
        second.flush()
        let a = await first.summary(for: now)
        let b = await second.summary(for: now)
        XCTAssertEqual(a.upright + b.upright, 400, accuracy: 0.1)
        core.shutdown()
    }

    func testHistoryCountsUprightSlouchAndAlerts() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-monitor-\(UUID().uuidString)")
        let store = PostureHistoryStore(directory: dir)
        let (monitor, _, clock) = makeMonitor(history: store)
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 10)
        feed(monitor, clock: clock, noseY: 0.6, from: 10.25, to: 20)
        monitor.flushHistory()
        store.flush()
        let summary = await store.summary(for: Date(timeIntervalSince1970: 1_800_000_010))
        XCTAssertEqual(summary.alerts, 1)
        XCTAssertGreaterThan(summary.upright, 9)
        XCTAssertGreaterThan(summary.slouch, 7)
    }

    /// H1: a reading scored just before a pause raises the rate, and its `setMode` is slow. The pause
    /// must still be the last word: the camera ends off, not back on at the confirmation rate.
    func testAReadingScoredBeforeAPauseCannotTurnTheCameraBackOn() throws {
        let (monitor, camera, clock) = makeMonitor()
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 1)
        XCTAssertEqual(camera.modes.last, .continuous(fps: 2))
        camera.hold(.continuous(fps: 10))
        let readings = DispatchGroup()
        readings.enter()
        DispatchQueue.global().async {
            var time = 1.25
            while time <= 2.5 {
                monitor.ingest(postureSample(noseY: 0.6, time: time))
                time += 0.25
            }
            readings.leave()
        }
        XCTAssertEqual(camera.entered.wait(timeout: .now() + 5), .success, "a slouch became pending")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { camera.release.signal() }
        clock.now = 3
        monitor.pause(until: nil)
        XCTAssertEqual(readings.wait(timeout: .now() + 5), .success)
        settle()
        XCTAssertEqual(monitor.state, .paused(PosturePause(reasons: [.user])))
        XCTAssertEqual(camera.modes.last, .off, "the pause came last, so the light is off")
    }

    /// H2: a monitor released without `disable()` turns the camera off.
    func testReleasingTheMonitorTurnsTheCameraOff() throws {
        let released = WeakMonitor()
        let camera = try runAndRelease(into: released)
        settle()
        XCTAssertNil(released.monitor, "nothing else keeps the monitor alive")
        XCTAssertEqual(camera.modes.last, .off)
    }

    private final class WeakMonitor {
        weak var monitor: PostureMonitor?
    }

    private func runAndRelease(into released: WeakMonitor) throws -> RecordingCamera {
        let (monitor, camera, clock) = makeMonitor()
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 1)
        XCTAssertEqual(camera.modes.last, .continuous(fps: 2))
        released.monitor = monitor
        return camera
    }

    func testCalibrationCollectsSamplesFromTheRunningPipeline() async throws {
        let (monitor, camera, _) = makeMonitor()
        monitor.enable()
        settle()
        XCTAssertEqual(camera.modes.last, .off, "no baseline yet")
        let collection = Task { try await monitor.collectCalibrationSamples(count: 4, timeout: 10) }
        for _ in 0..<200 where camera.modes.last != .continuous(fps: 10) { await Task.yield() }
        XCTAssertEqual(camera.modes.last, .continuous(fps: 10), "the camera runs at the active rate while collecting")
        monitor.ingest(postureSample(time: 0, confidence: 0.1))
        var dark = postureSample(time: 0.1)
        dark.lowLight = true
        monitor.ingest(dark)
        for index in 0..<5 { monitor.ingest(postureSample(time: 1 + Double(index) * 0.1)) }
        let samples = try await collection.value
        XCTAssertEqual(samples.count, 4, "nobody and dark frames do not count")
        XCTAssertEqual(samples.first?.time, 1)
        XCTAssertNotNil(PostureBaseline.calibrate(upright: samples.map(PostureMetrics.init(sample:))))
        settle()
        XCTAssertEqual(camera.modes.last, .off, "back to the monitor's own wish")
        XCTAssertEqual(monitor.state, .needsCalibration)
    }

    func testCalibrationTimesOutWithWhatItHasAndRefusesASecondCollector() async throws {
        let (monitor, _, _) = makeMonitor()
        let first = Task { try await monitor.collectCalibrationSamples(count: 10, timeout: 0.3) }
        await Task.yield()
        monitor.ingest(postureSample(time: 0))
        do {
            _ = try await monitor.collectCalibrationSamples(count: 2, timeout: 1)
            XCTFail("a second collection runs")
        } catch {
            XCTAssertEqual(error as? PostureCalibrationError, .busy)
        }
        do {
            _ = try await first.value
            XCTFail("no timeout")
        } catch let PostureCalibrationError.timedOut(collected) {
            XCTAssertEqual(collected.count, 1)
        }
    }

    func testASlouchAlertCarriesTheFaultAndItsDrift() throws {
        let (monitor, _, clock) = makeMonitor()
        var alerts: [PostureAlert] = []
        monitor.onAlert = { alerts.append($0) }
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 1)
        feed(monitor, clock: clock, noseY: 0.6, from: 1.25, to: 4)
        XCTAssertEqual(monitor.state, .slouching)
        let alert = try XCTUnwrap(monitor.lastAlert)
        XCTAssertEqual(alerts, [alert])
        XCTAssertEqual(alert.kind, .headDrop)
        XCTAssertEqual(alert.measure, .headHeight)
        XCTAssertEqual(alert.unit, .shoulderWidths)
        // The nose dropped 0.15 image heights below shoulders 0.4 image heights wide.
        XCTAssertEqual(alert.deviation, 0.15 / 0.4, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(alert.approximateCentimeters()), alert.deviation * 39, accuracy: 1e-9)
        XCTAssertGreaterThan(alert.severity, 0)
        XCTAssertGreaterThan(alert.rangeFraction, 0)
    }

    /// Live run 2026-10-14 02:34: the slouch the calibration sheet asks for became an alert, and the effect
    /// came on as the sheet closed. A held monitor judges nothing; the feed still gets every reading.
    func testHeldScoringJudgesNothingAndTheReleaseStartsAfresh() throws {
        let (monitor, _, clock) = makeMonitor()
        var alerts: [PostureAlert] = []
        monitor.onAlert = { alerts.append($0) }
        monitor.setBaseline(try baseline())
        monitor.enable()
        monitor.feed.beginWatching()
        defer { monitor.feed.endWatching() }
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 1)
        monitor.holdScoring(true)
        XCTAssertTrue(monitor.isScoringHeld)
        feed(monitor, clock: clock, noseY: 0.6, from: 1.25, to: 6)
        XCTAssertEqual(monitor.state, .monitoring, "a held monitor judges no reading")
        XCTAssertTrue(alerts.isEmpty)
        XCTAssertNil(monitor.lastAlert)
        XCTAssertEqual(monitor.feed.sample?.time, 6, "the calibration sheet's skeleton still gets every reading")

        monitor.holdScoring(false)
        XCTAssertFalse(monitor.isScoringHeld)
        feed(monitor, clock: clock, noseY: 0.6, from: 6.25, to: 7.75)
        XCTAssertEqual(monitor.state, .monitoring, "the slouch timer starts at the release, not before it")
        feed(monitor, clock: clock, noseY: 0.6, from: 8, to: 9)
        XCTAssertEqual(monitor.state, .slouching)
        XCTAssertEqual(alerts.count, 1)
    }

    func testHoldingDuringASlouchEndsItAndANewBaselineJudgesFromScratch() throws {
        let (monitor, _, clock) = makeMonitor()
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 1)
        feed(monitor, clock: clock, noseY: 0.6, from: 1.25, to: 4)
        XCTAssertEqual(monitor.state, .slouching)
        monitor.holdScoring(true)
        settle()
        XCTAssertEqual(monitor.state, .monitoring, "the sheet opened: the episode is dropped, not carried over")
        monitor.holdScoring(false)
        feed(monitor, clock: clock, noseY: 0.6, from: 4.25, to: 7)
        XCTAssertEqual(monitor.state, .slouching)

        let slouched = try XCTUnwrap(PostureBaseline.calibrate(
            upright: (0..<4).map { _ in PostureMetrics(sample: postureSample(noseY: 0.6)) }))
        monitor.setBaseline(slouched)
        settle()
        XCTAssertEqual(monitor.state, .monitoring, "a slouch judged against the old baseline means nothing now")
    }

    func testTheFaceEngineKeepsJudgingForwardHeadWhenBodyReadingsNeedShoulders() throws {
        let clock = ClockBox()
        let configuration = PostureMonitor.Configuration(
            scorer: PostureScorer(forwardHeadWithoutShoulders: .needsShoulders),
            timing: PostureTiming(confirmBad: 1, confirmGood: 0.5, onsetDelay: 1, resetStreak: 2, resumeGrace: 0))
        func run(_ engine: PoseEngineKind) throws -> PostureState {
            let monitor = PostureMonitor(configuration: configuration, camera: nil, cameraControl: RecordingCamera(),
                                         engine: NoEngine(), history: nil, clock: { clock.now },
                                         wallClock: { Date(timeIntervalSince1970: 1_800_000_000 + clock.now) })
            func sample(width: Double, time: TimeInterval) -> PoseSample {
                let joints: [PoseJoint: PoseJointPoint] = engine == .visionBody ? [.nose: PoseJointPoint(x: 0.5, y: 0.45, confidence: 0.9)] : [:]
                return PoseSample(time: time, engine: engine, joints: joints,
                                  face: PoseFace(box: CGRect(x: 0.4, y: 0.3, width: width, height: width),
                                                 confidence: 0.9, roll: 0, pitch: 0.05))
            }
            monitor.setBaseline(try XCTUnwrap(PostureBaseline.calibrate(
                upright: (0..<5).map { _ in PostureMetrics(sample: sample(width: 0.2, time: 0)) })))
            monitor.enable()
            clock.now = 0
            feedSamples(monitor, clock: clock, from: 0, to: 4) { sample(width: 0.26, time: $0) }
            return monitor.state
        }
        XCTAssertEqual(try run(.visionFace), .slouching, "the face width is the face engine's own measure")
        XCTAssertEqual(try run(.visionBody), .monitoring, "a body reading without shoulders leaves Forward head unjudged")
    }

    /// Review of #514 (2026-10-14): after the user left, a throttled frame still merged the last 3D shoulders, so an
    /// empty frame read as a person with the head dropped (a severe slouch) instead of away. Cached shoulders now
    /// count only when the frame shows the person by itself.
    func testCachedShouldersDoNotKeepAPersonWhoLeft() {
        let full = postureSample().joints
        let shoulders = full.filter { VisionPose.shoulderJoints.contains($0.key) }
        XCTAssertFalse(shoulders.isEmpty)

        // The user left: no 2D joint, no face, only the cached 3D shoulders.
        let empty = VisionBodyPoseEngine.trustedJoints(shoulders, current: [:], cachedShoulders: true, face: nil)
        XCTAssertTrue(empty.isEmpty, "cached shoulders alone are not a person")
        XCTAssertFalse(PoseSample(time: 0, engine: .visionBody, joints: empty).hasPerson)

        // Still there: the face (or any own 2D joint) keeps the cached shoulders.
        let face = PoseFace(box: CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.25), confidence: 0.9)
        XCTAssertEqual(VisionBodyPoseEngine.trustedJoints(shoulders, current: [:], cachedShoulders: true, face: face).count,
                       shoulders.count)
        let nose = [PoseJoint.nose: PoseJointPoint(x: 0.5, y: 0.45, confidence: 0.9)]
        XCTAssertEqual(VisionBodyPoseEngine.trustedJoints(shoulders.merging(nose) { $1 }, current: nose,
                                                          cachedShoulders: true, face: nil).count, shoulders.count + 1)
        // A faint face or only shoulder-like 2D joints do not count.
        let faint = PoseFace(box: CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.25), confidence: 0.05)
        XCTAssertTrue(VisionBodyPoseEngine.trustedJoints(shoulders, current: shoulders, cachedShoulders: true, face: faint).isEmpty)
        // Shoulders from this frame's own 3D run stay.
        XCTAssertEqual(VisionBodyPoseEngine.trustedJoints(shoulders, current: [:], cachedShoulders: false, face: nil).count,
                       shoulders.count)
    }

    /// Two people: the 3D body and the face follow the person the 2D shoulders already chose, not the
    /// highest confidence or the largest box.
    func testThe3DBodyAndTheFaceFollowTheSelectedPerson() {
        let person = [
            PoseJoint.leftShoulder: PoseJointPoint(x: 0.30, y: 0.50, confidence: 0.9),
            PoseJoint.rightShoulder: PoseJointPoint(x: 0.50, y: 0.50, confidence: 0.9),
            PoseJoint.nose: PoseJointPoint(x: 0.40, y: 0.30, confidence: 0.9),
        ]
        func body(_ confidence: Double, leftX: Double, rightX: Double) -> VisionPose.Body3DCandidate {
            VisionPose.Body3DCandidate(
                confidence: confidence,
                left: PoseJointPoint(x: leftX, y: 0.50, confidence: confidence),
                right: PoseJointPoint(x: rightX, y: 0.50, confidence: confidence),
                neck: PoseJointPoint(x: (leftX + rightX) / 2, y: 0.42, confidence: confidence))
        }
        let near = body(0.5, leftX: 0.35, rightX: 0.45)
        let far = body(0.95, leftX: 0.75, rightX: 0.95)
        XCTAssertEqual(VisionPose.selectBody([far, near], matching: person)?.confidence, 0.5)
        XCTAssertNil(VisionPose.selectBody([far], matching: person), "a far body is not this person")
        XCTAssertEqual(VisionPose.selectBody([far, near], matching: [:])?.confidence, 0.95,
                       "no 2D shoulders: the most confident 3D body, as when the camera is close")

        let own = PoseFace(box: CGRect(x: 0.32, y: 0.18, width: 0.16, height: 0.22), confidence: 0.6)
        let other = PoseFace(box: CGRect(x: 0.70, y: 0.10, width: 0.28, height: 0.34), confidence: 0.99)
        XCTAssertEqual(VisionPose.selectFace([other, own], near: person[.nose])?.confidence, 0.6)
        XCTAssertNil(VisionPose.selectFace([other], near: person[.nose]))
        XCTAssertEqual(VisionPose.selectFace([other, own], near: nil)?.confidence, 0.99)
    }

    /// Live run 2026-10-14: a hand over one shoulder left the nose, the eyes and one shoulder. The body
    /// engine skipped the face request (it had a nose), so no measure came out and "Upright" stayed.
    func testTheBodyEngineAsksForTheFaceWhenAShoulderOrTheNoseIsMissing() {
        let full = postureSample().joints
        XCTAssertFalse(VisionBodyPoseEngine.needsFace(full))
        var oneShoulder = full
        oneShoulder[.rightShoulder] = nil
        XCTAssertTrue(VisionBodyPoseEngine.needsFace(oneShoulder))
        var faintNose = full
        faintNose[.nose] = PoseJointPoint(x: 0.5, y: 0.45, confidence: 0.1)
        XCTAssertTrue(VisionBodyPoseEngine.needsFace(faintNose))
        XCTAssertTrue(VisionBodyPoseEngine.needsFace([:]))
    }

    /// A baseline calibrated while the body pose found no shoulders holds only face measures, so every
    /// frame needs the face request, or a reading with a nose has nothing to compare.
    func testAFaceOnlyBaselineKeepsTheFaceRequestOnEveryFrame() throws {
        let face = PoseSample(time: 0, engine: .visionBody,
                              joints: [.nose: PoseJointPoint(x: 0.5, y: 0.45, confidence: 0.9)],
                              face: PoseFace(box: CGRect(x: 0.4, y: 0.3, width: 0.2, height: 0.2), confidence: 0.9, roll: 0, pitch: 0))
        let faceOnly = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<5).map { _ in PostureMetrics(sample: face) }))
        let body = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<5).map { _ in PostureMetrics(sample: postureSample()) }))
        XCTAssertTrue(PostureCore.needsFaceOnEveryFrame(calibrating: false, baseline: faceOnly))
        XCTAssertFalse(PostureCore.needsFaceOnEveryFrame(calibrating: false, baseline: body))
        XCTAssertTrue(PostureCore.needsFaceOnEveryFrame(calibrating: true, baseline: body))
        XCTAssertFalse(PostureCore.needsFaceOnEveryFrame(calibrating: false, baseline: nil))
    }

    /// The same reading once the face rides along: head on one hand, one shoulder hidden, the face rolled
    /// 0.6 rad and lower. Against a face-only baseline that is a slouch, not "Upright".
    func testAHeadOnHandWithOneShoulderHiddenSlouchesAgainstAFaceOnlyBaseline() throws {
        let clock = ClockBox()
        let configuration = PostureMonitor.Configuration(
            scorer: PostureScorer(forwardHeadWithoutShoulders: .needsShoulders),
            timing: PostureTiming(confirmBad: 1, confirmGood: 0.5, onsetDelay: 1, resetStreak: 2, resumeGrace: 0))
        let monitor = PostureMonitor(configuration: configuration, camera: nil, cameraControl: RecordingCamera(),
                                     engine: NoEngine(), history: nil, clock: { clock.now },
                                     wallClock: { Date(timeIntervalSince1970: 1_800_000_000 + clock.now) })
        func sample(roll: Double, y: Double, time: TimeInterval) -> PoseSample {
            PoseSample(time: time, engine: .visionBody,
                       joints: [.nose: PoseJointPoint(x: 0.5, y: y + 0.1, confidence: 0.9),
                                .leftShoulder: PoseJointPoint(x: 0.2, y: 0.8, confidence: 0.9)],
                       face: PoseFace(box: CGRect(x: 0.4, y: y, width: 0.3, height: 0.3), confidence: 0.9, roll: roll, pitch: 0))
        }
        monitor.setBaseline(try XCTUnwrap(PostureBaseline.calibrate(
            upright: (0..<5).map { _ in PostureMetrics(sample: sample(roll: 0, y: 0.3, time: 0)) })))
        monitor.enable()
        clock.now = 0
        feedSamples(monitor, clock: clock, from: 0, to: 4) { sample(roll: 0.6, y: 0.4, time: $0) }
        XCTAssertEqual(monitor.state, .slouching)
    }

    private func feedSamples(_ monitor: PostureMonitor, clock: ClockBox, from: TimeInterval, to: TimeInterval,
                             _ make: (TimeInterval) -> PoseSample) {
        var time = from
        while time <= to + 1e-9 {
            clock.now = time
            monitor.ingest(make(time))
            time += 0.25
        }
        settle()
    }

    func testHistoryCanBeSwitchedOffAndOn() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-switch-\(UUID().uuidString)")
        let store = PostureHistoryStore(directory: dir)
        let (monitor, _, clock) = makeMonitor()
        XCTAssertNil(monitor.history)
        monitor.setBaseline(try baseline())
        monitor.enable()
        feed(monitor, clock: clock, noseY: 0.45, from: 0, to: 10)
        monitor.setHistory(store)
        XCTAssertTrue(monitor.history === store)
        feed(monitor, clock: clock, noseY: 0.45, from: 10.25, to: 20)
        monitor.setHistory(nil)
        feed(monitor, clock: clock, noseY: 0.45, from: 20.25, to: 40)
        monitor.flushHistory()
        store.flush()
        let summary = await store.summary(for: Date(timeIntervalSince1970: 1_800_000_010))
        XCTAssertEqual(summary.upright, 10, accuracy: 1, "only the 10 s while the store was on")
    }

    func testAutoUsesAirPodsOnlyWithAPitchBaseline() throws {
        let camera = try baseline()
        var both = camera
        both.metrics[.headphonePitch] = 0
        XCTAssertFalse(PostureMonitor.readsHeadphones(source: .auto, hasEngine: true, connected: true, baseline: camera),
                       "Auto keeps the camera rather than stopping for an AirPods calibration")
        XCTAssertTrue(PostureMonitor.readsHeadphones(source: .auto, hasEngine: true, connected: true, baseline: both))
        XCTAssertFalse(PostureMonitor.readsHeadphones(source: .auto, hasEngine: true, connected: false, baseline: both))
        XCTAssertTrue(PostureMonitor.readsHeadphones(source: .headphones, hasEngine: false, connected: false, baseline: nil))
    }
}
