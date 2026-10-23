import XCTest
@testable import GenesisKitBase
@testable import GenesisKit
@testable import GenesisKitPosture

/// A body sample whose shoulders came from `source`, read `age` seconds before `time`.
private func shoulderSample(tilt: Double = 0, time: TimeInterval = 0, source: PoseShoulderSource = .body3D,
                            age: TimeInterval = 0) -> PoseSample {
    var sample = postureSample(shoulderTilt: tilt, time: time)
    sample.shoulderSource = source
    sample.shoulderAge = age
    return sample
}

final class PostureShoulderSourceTests: XCTestCase {
    private func baseline(_ source: PoseShoulderSource?) throws -> PostureBaseline {
        try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: postureSample()) },
                                                shoulderSource: source))
    }

    func testTheCalibrationRecordsWhereItsShouldersCameFrom() throws {
        var session = PostureCalibrationSession()
        for index in 0..<5 { session.add(shoulderSample(time: Double(index)), as: .upright) }
        XCTAssertEqual(session.shoulderSource, .body3D)
        XCTAssertEqual(try XCTUnwrap(session.baseline()).shoulderSource, .body3D)

        var untold = PostureCalibrationSession()
        for index in 0..<5 { untold.add(postureSample(time: Double(index)), as: .upright) }
        XCTAssertNil(try XCTUnwrap(untold.baseline()).shoulderSource, "a sample that does not say leaves it unknown")
    }

    func testAnOldCalibrationFileLoadsWithNoShoulderSource() throws {
        let encoded = try JSONEncoder().encode(try baseline(.body3D))
        XCTAssertEqual(try JSONDecoder().decode(PostureBaseline.self, from: encoded).shoulderSource, .body3D)

        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object["shoulderSource"] = nil
        let old = try JSONSerialization.data(withJSONObject: object)
        let decoded = try JSONDecoder().decode(PostureBaseline.self, from: old)
        XCTAssertNil(decoded.shoulderSource)
        XCTAssertTrue(decoded.shoulderSourceDiffers(from: .body3D), "an unknown source cannot be trusted")
        XCTAssertTrue(decoded.shoulderSourceDiffers(from: .body2D))
        XCTAssertFalse(decoded.shoulderSourceDiffers(from: nil), "no live source, nothing to compare")
    }

    func testASampleKeepsItsShoulderSourceAndAgeThroughJSON() throws {
        let sample = shoulderSample(time: 3, age: 1.5)
        let decoded = try JSONDecoder().decode(PoseSample.self, from: JSONEncoder().encode(sample))
        XCTAssertEqual(decoded, sample)
        XCTAssertFalse(decoded.hasFreshShoulders)
        XCTAssertTrue(shoulderSample(age: 0).hasFreshShoulders)
    }

    /// Debug recording 2026-10-19 22:28:57: a 2D baseline against 3D shoulders judged a level shoulder line
    /// tilted and could never see a lean. Against another source the shoulder faults are left unjudged.
    func testShouldersFromAnotherRequestAreNotJudged() throws {
        let level = PostureMetrics(sample: shoulderSample())
        let tilted = PostureMetrics(sample: shoulderSample(tilt: 0.1))
        let scorer = PostureScorer()

        let same = scorer.score(tilted, against: try baseline(.body3D), shoulderSource: .body3D)
        XCTAssertFalse(same.shoulderSourceMismatch)
        XCTAssertEqual(same.worst, .shoulderTilt)

        for stored in [PoseShoulderSource.body2D, nil] {
            let other = scorer.score(tilted, against: try baseline(stored), shoulderSource: .body3D)
            XCTAssertTrue(other.shoulderSourceMismatch)
            XCTAssertFalse(other.isBad)
            XCTAssertTrue(other.signals.isEmpty, "every measure of this body sample divides by the shoulders")
            XCTAssertEqual(other.unjudged, [.headDrop, .forwardHead, .leanIn, .shoulderTilt, .lateralLean])
        }

        let unchecked = scorer.score(tilted, against: try baseline(nil))
        XCTAssertFalse(unchecked.shoulderSourceMismatch, "without a live source the scorer compares as before")
        XCTAssertTrue(scorer.score(level, against: try baseline(nil)).isClear)
    }

    func testTheFaceStillJudgesWhenTheShouldersDoNot() throws {
        var upright = shoulderSample()
        upright.face = PoseFace(box: CGRect(x: 0.4, y: 0.3, width: 0.2, height: 0.25))
        var dropped = upright
        dropped.face?.box.origin.y += 0.1
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: upright) }))
        let score = PostureScorer().score(PostureMetrics(sample: dropped), against: base, shoulderSource: .body3D)
        XCTAssertTrue(score.shoulderSourceMismatch)
        XCTAssertEqual(score.signals.first { $0.kind == .headDrop }?.measure, .faceCenterY)
        XCTAssertTrue(score.isBad, "the face centre still measures a head drop")
        XCTAssertTrue(score.unjudged.isSuperset(of: [.leanIn, .shoulderTilt]))
    }

    func testAMismatchedBaselineReadsTheFaceOnEveryFrame() throws {
        XCTAssertTrue(PostureCore.needsFaceOnEveryFrame(calibrating: false, baseline: try baseline(nil), liveShoulders: .body3D),
                      "the face is all that is left to judge with")
        XCTAssertFalse(PostureCore.needsFaceOnEveryFrame(calibrating: false, baseline: try baseline(.body3D),
                                                         liveShoulders: .body3D))
        XCTAssertEqual(PostureCore.shoulderSource(of: VisionBodyPoseEngine()), .body3D)
        XCTAssertEqual(PostureCore.shoulderSource(of: VisionBodyPoseEngine(body3D: .never)), .body2D)
        XCTAssertNil(PostureCore.shoulderSource(of: VisionFaceEngine()))
    }

    func testTheEngineStampsWhereTheShouldersCameFrom() {
        let both: [PoseJoint: PoseJointPoint] = [
            .leftShoulder: PoseJointPoint(x: 0.7, y: 0.8, confidence: 1),
            .rightShoulder: PoseJointPoint(x: 0.3, y: 0.8, confidence: 1),
        ]
        XCTAssertNil(VisionBodyPoseEngine.shoulderStamp([:], body3D: .throttled, readAt: 1, time: 2))
        XCTAssertEqual(VisionBodyPoseEngine.shoulderStamp(both, body3D: .never, readAt: nil, time: 2)?.source, .body2D)
        XCTAssertEqual(VisionBodyPoseEngine.shoulderStamp(both, body3D: .never, readAt: nil, time: 2)?.age, 0)
        let held = VisionBodyPoseEngine.shoulderStamp(both, body3D: .throttled, readAt: 1, time: 3.5)
        XCTAssertEqual(held?.source, .body3D)
        XCTAssertEqual(held?.age, 2.5)
        XCTAssertEqual(VisionBodyPoseEngine.shoulderStamp(both, body3D: .always, readAt: 2, time: 2)?.age, 0)
    }

    // MARK: - Held 3D shoulders

    /// One fresh bad 3D reading is held and asks for another; the second agrees and the fault counts, also on
    /// the held frames after it; a fresh reading that is no longer bad lets go at once.
    func testAShoulderFaultNeedsTwoFresh3DReadingsInARow() throws {
        let base = try baseline(.body3D)
        let scorer = PostureScorer()
        var gate = PostureShoulderGate()
        func step(tilt: Double, fresh: Bool) -> (score: PostureScore, readAgain: Bool) {
            let score = scorer.score(PostureMetrics(sample: shoulderSample(tilt: tilt)), against: base,
                                     shoulderSource: .body3D)
            return gate.apply(score, fresh: fresh ? score : nil, source: .body3D, scorer: scorer)
        }

        let first = step(tilt: 0.1, fresh: true)
        XCTAssertTrue(first.readAgain)
        XCTAssertFalse(first.score.isBad)
        XCTAssertFalse(first.score.isClear, "held is neither bad nor clear, so it ends no slouch either")
        XCTAssertEqual(first.score.held, [.shoulderTilt])
        XCTAssertEqual(first.score.severity, 0)
        XCTAssertNil(first.score.worst)

        let between = step(tilt: 0.1, fresh: false)
        XCTAssertFalse(between.readAgain, "a held frame asks for nothing new")
        XCTAssertEqual(between.score.held, [.shoulderTilt])

        let second = step(tilt: 0.1, fresh: true)
        XCTAssertFalse(second.readAgain)
        XCTAssertTrue(second.score.isBad)
        XCTAssertTrue(second.score.held.isEmpty)
        XCTAssertGreaterThan(second.score.strength, 0)

        XCTAssertTrue(step(tilt: 0.1, fresh: false).score.isBad, "a confirmed reading stays bad while it is held")

        let level = step(tilt: 0, fresh: true)
        XCTAssertTrue(level.score.isClear)
        XCTAssertTrue(gate.confirmed.isEmpty)
        let again = step(tilt: 0.1, fresh: true)
        XCTAssertEqual(again.score.held, [.shoulderTilt], "after a level reading the next tilt waits again")
    }

    func testA2DReadingPassesTheGateUnchanged() throws {
        let base = try baseline(.body2D)
        let scorer = PostureScorer()
        var gate = PostureShoulderGate()
        let score = scorer.score(PostureMetrics(sample: shoulderSample(tilt: 0.1, source: .body2D)), against: base,
                                 shoulderSource: .body2D)
        let result = gate.apply(score, fresh: score, source: .body2D, scorer: scorer)
        XCTAssertEqual(result.score, score)
        XCTAssertFalse(result.readAgain)
    }

    /// The confirming frame came back without shoulders: the smoothed score still carries the first reading's tilt,
    /// and it stays held, not bad. A 2D engine's frame without shoulders passes as before.
    func testAFrameWithoutShouldersKeepsAnUnconfirmedFaultHeld() throws {
        let base = try baseline(.body3D)
        let scorer = PostureScorer()
        var gate = PostureShoulderGate()
        let bad = scorer.score(PostureMetrics(sample: shoulderSample(tilt: 0.1)), against: base, shoulderSource: .body3D)
        XCTAssertTrue(gate.apply(bad, fresh: bad, source: .body3D, scorer: scorer).readAgain)
        let smoothed = scorer.score(PostureMetrics(sample: shoulderSample(tilt: 0.1)), against: base, shoulderSource: nil)
        XCTAssertTrue(smoothed.isBad, "positive control: the smoothed shoulders alone are bad")
        let faceOnly = gate.apply(smoothed, fresh: nil, source: nil, scorer: scorer)
        XCTAssertFalse(faceOnly.score.isBad)
        XCTAssertEqual(faceOnly.score.held, [.shoulderTilt])

        var flat = PostureShoulderGate()
        let base2D = try baseline(.body2D)
        let bad2D = scorer.score(PostureMetrics(sample: shoulderSample(tilt: 0.1, source: .body2D)), against: base2D,
                                 shoulderSource: .body2D)
        _ = flat.apply(bad2D, fresh: nil, source: .body2D, scorer: scorer)
        let missed = scorer.score(PostureMetrics(sample: shoulderSample(tilt: 0.1)), against: base2D, shoulderSource: nil)
        XCTAssertEqual(flat.apply(missed, fresh: nil, source: nil, scorer: scorer).score, missed)
    }

    /// The smoother still holds the old shoulders for a moment after a fresh level reading; that reading wins.
    func testAFreshLevelReadingHoldsAStillBadSmoothedScore() throws {
        let base = try baseline(.body3D)
        let scorer = PostureScorer()
        var gate = PostureShoulderGate()
        let bad = scorer.score(PostureMetrics(sample: shoulderSample(tilt: 0.1)), against: base, shoulderSource: .body3D)
        _ = gate.apply(bad, fresh: bad, source: .body3D, scorer: scorer)
        XCTAssertTrue(gate.apply(bad, fresh: bad, source: .body3D, scorer: scorer).score.isBad)
        let level = scorer.score(PostureMetrics(sample: shoulderSample()), against: base, shoulderSource: .body3D)
        let result = gate.apply(bad, fresh: level, source: .body3D, scorer: scorer)
        XCTAssertFalse(result.score.isBad)
        XCTAssertEqual(result.score.held, [.shoulderTilt])
    }
}

@MainActor
final class PostureShoulderGateMonitorTests: XCTestCase {
    func testAHeldTiltSlouchesOnlyAfterAFreshReadingAgrees() throws {
        let clock = ClockBox()
        let configuration = PostureMonitor.Configuration(
            timing: PostureTiming(confirmBad: 1, confirmGood: 0.5, onsetDelay: 1, resetStreak: 2, resumeGrace: 0))
        let monitor = PostureMonitor(configuration: configuration, camera: nil, cameraControl: RecordingCamera(),
                                     engine: NoEngine(), history: nil, clock: { clock.now },
                                     wallClock: { Date(timeIntervalSince1970: 1_800_000_000 + clock.now) })
        monitor.setBaseline(try XCTUnwrap(PostureBaseline.calibrate(
            upright: (0..<4).map { _ in PostureMetrics(sample: shoulderSample()) }, shoulderSource: .body3D)))
        monitor.enable()
        // One fresh tilted reading, then 4 s of frames that only hold it: no slouch.
        var time = 0.0
        while time <= 4 {
            clock.now = time
            monitor.ingest(shoulderSample(tilt: 0.1, time: time, age: time))
            time += 0.25
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(monitor.state, .monitoring, "one 3D reading held for 4 s is not a slouch")
        // A second fresh reading agrees: from here the held frames count.
        let confirmedAt = time
        while time <= confirmedAt + 3 {
            clock.now = time
            monitor.ingest(shoulderSample(tilt: 0.1, time: time, age: time - confirmedAt))
            time += 0.25
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(monitor.state, .slouching)
    }

    func testAnOldCalibrationIsNotJudgedOnLiveShoulders() throws {
        let clock = ClockBox()
        let configuration = PostureMonitor.Configuration(
            timing: PostureTiming(confirmBad: 1, confirmGood: 0.5, onsetDelay: 1, resetStreak: 2, resumeGrace: 0))
        let monitor = PostureMonitor(configuration: configuration, camera: nil, cameraControl: RecordingCamera(),
                                     engine: NoEngine(), history: nil, clock: { clock.now },
                                     wallClock: { Date(timeIntervalSince1970: 1_800_000_000 + clock.now) })
        monitor.setBaseline(try XCTUnwrap(PostureBaseline.calibrate(
            upright: (0..<4).map { _ in PostureMetrics(sample: shoulderSample()) })))
        monitor.enable()
        monitor.feed.beginWatching()
        defer { monitor.feed.endWatching() }
        var time = 0.0
        while time <= 5 {
            clock.now = time
            monitor.ingest(shoulderSample(tilt: 0.1, time: time))
            time += 0.25
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(monitor.state, .monitoring)
        XCTAssertEqual(monitor.feed.score?.shoulderSourceMismatch, true)
        XCTAssertEqual(monitor.feed.score?.unjudged.contains(.shoulderTilt), true)
    }

    /// 2D shoulders against a 3D baseline are not judged, and the face-only frame after them must not judge them
    /// either: that frame names no source, and the smoother still holds the frames before it.
    func testAFaceOnlyFrameDoesNotJudgeShouldersFromAnotherRequest() throws {
        let clock = ClockBox()
        let monitor = PostureMonitor(configuration: PostureMonitor.Configuration(), camera: nil,
                                     cameraControl: RecordingCamera(), engine: NoEngine(), history: nil,
                                     clock: { clock.now }, wallClock: { Date(timeIntervalSince1970: 1_800_000_000 + clock.now) })
        let face = PoseFace(box: CGRect(x: 0.4, y: 0.3, width: 0.2, height: 0.25))
        func withFace(_ sample: PoseSample) -> PoseSample {
            var sample = sample
            sample.face = face
            return sample
        }
        monitor.setBaseline(try XCTUnwrap(PostureBaseline.calibrate(
            upright: (0..<4).map { _ in PostureMetrics(sample: withFace(shoulderSample())) }, shoulderSource: .body3D)))
        monitor.enable()
        monitor.feed.beginWatching()
        defer { monitor.feed.endWatching() }
        for time in [0, 0.25] {
            clock.now = time
            monitor.ingest(withFace(shoulderSample(tilt: 0.1, time: time, source: .body2D)))
        }
        clock.now = 0.5
        var faceOnly = PoseSample(time: 0.5, engine: .visionBody, joints: [:], imageAspect: 1)
        faceOnly.face = face
        monitor.ingest(faceOnly)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let score = try XCTUnwrap(monitor.feed.score)
        XCTAssertFalse(score.signals.contains { $0.measure.usesShoulders }, "\(score.signals)")
        XCTAssertFalse(score.isBad)
    }
}
