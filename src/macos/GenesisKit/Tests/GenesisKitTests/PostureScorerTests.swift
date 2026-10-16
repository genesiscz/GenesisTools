import XCTest
@testable import GenesisKit
@testable import GenesisKitPosture

/// Builds an upright-ish body sample: shoulders 0.4 wide at y 0.75, eyes 0.1 apart, nose at `noseY`. The
/// image is square unless asked, so x and y distances are the same unit and the numbers stay readable;
/// `testHorizontalDistancesUseTheImageAspect` covers other shapes.
func postureSample(noseY: Double = 0.45, noseX: Double = 0.5, shoulderWidth: Double = 0.4, shoulderTilt: Double = 0,
                   time: TimeInterval = 0, eyeSpan: Double = 0.1, confidence: Double = 0.9,
                   imageAspect: Double = 1) -> PoseSample {
    let half = shoulderWidth / 2
    let joints: [PoseJoint: PoseJointPoint] = [
        .nose: PoseJointPoint(x: noseX, y: noseY, confidence: confidence),
        .leftEye: PoseJointPoint(x: noseX + eyeSpan / 2, y: noseY - 0.04, confidence: confidence),
        .rightEye: PoseJointPoint(x: noseX - eyeSpan / 2, y: noseY - 0.04, confidence: confidence),
        .leftShoulder: PoseJointPoint(x: 0.5 + half, y: 0.75 - shoulderTilt / 2, confidence: confidence),
        .rightShoulder: PoseJointPoint(x: 0.5 - half, y: 0.75 + shoulderTilt / 2, confidence: confidence),
    ]
    return PoseSample(time: time, engine: .visionBody, joints: joints, imageAspect: imageAspect)
}

final class PostureScorerTests: XCTestCase {
    private func baseline() throws -> PostureBaseline {
        let readings = (0..<6).map { PostureMetrics(sample: postureSample(noseY: 0.45 + Double($0 % 2) * 0.004)) }
        return try XCTUnwrap(PostureBaseline.calibrate(upright: readings))
    }

    func testMetricsAreNormalisedByShoulderWidth() throws {
        let near = PostureMetrics(sample: postureSample(noseY: 0.45, shoulderWidth: 0.4))
        XCTAssertEqual(try XCTUnwrap(near[.headHeight]), 0.75, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(near[.eyeSpanRatio]), 0.25, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(near[.lateralOffset]), 0, accuracy: 1e-9)
        // The same pose further from the camera: everything half the size, same normalized values.
        let far = PoseSample(time: 0, engine: .visionBody, joints: [
            .nose: PoseJointPoint(x: 0.5, y: 0.6, confidence: 0.9),
            .leftEye: PoseJointPoint(x: 0.525, y: 0.58, confidence: 0.9),
            .rightEye: PoseJointPoint(x: 0.475, y: 0.58, confidence: 0.9),
            .leftShoulder: PoseJointPoint(x: 0.6, y: 0.75, confidence: 0.9),
            .rightShoulder: PoseJointPoint(x: 0.4, y: 0.75, confidence: 0.9),
        ], imageAspect: 1)
        let farMetrics = PostureMetrics(sample: far)
        XCTAssertEqual(try XCTUnwrap(farMetrics[.headHeight]), 0.75, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(farMetrics[.eyeSpanRatio]), 0.25, accuracy: 1e-9)
    }

    func testLowConfidenceJointsAreLeftOut() {
        let metrics = PostureMetrics(sample: postureSample(confidence: 0.2))
        XCTAssertTrue(metrics.isEmpty)
        XCTAssertFalse(postureSample(confidence: 0.2).hasPerson)
    }

    func testTheBaselinePoseScoresClear() throws {
        let score = PostureScorer().score(PostureMetrics(sample: postureSample()), against: try baseline())
        XCTAssertFalse(score.isEmpty)
        XCTAssertFalse(score.isBad)
        XCTAssertTrue(score.isClear)
        XCTAssertEqual(score.severity, 0)
        XCTAssertNil(score.worst)
    }

    func testAHeadDropPastTheDeadZoneIsBadAndNamesTheFault() throws {
        let score = PostureScorer().score(PostureMetrics(sample: postureSample(noseY: 0.55)), against: try baseline())
        XCTAssertTrue(score.isBad)
        XCTAssertFalse(score.isClear)
        XCTAssertEqual(score.worst, .headDrop)
        XCTAssertEqual(score.severity, 1, accuracy: 1e-9)
    }

    func testTheDeadZoneMovesTheEnterThreshold() throws {
        let base = try baseline()
        // 0.1 shoulder widths of head drop: past Strict and Medium, inside Loose.
        let reading = PostureMetrics(sample: postureSample(noseY: 0.49))
        XCTAssertTrue(PostureScorer(deadZone: .strict).score(reading, against: base).isBad)
        XCTAssertTrue(PostureScorer(deadZone: .medium).score(reading, against: base).isBad)
        XCTAssertFalse(PostureScorer(deadZone: .loose).score(reading, against: base).isBad)
    }

    func testHysteresisBandIsNeitherBadNorClear() throws {
        let base = try baseline()
        let scorer = PostureScorer(deadZone: .relaxed)
        let signal = try XCTUnwrap(scorer.score(PostureMetrics(sample: postureSample()), against: base)
            .signals.first { $0.kind == .headDrop })
        XCTAssertLessThan(signal.exitThreshold, signal.enterThreshold)
        // A drop between the two thresholds.
        let middle = (signal.exitThreshold + signal.enterThreshold) / 2
        let height = try XCTUnwrap(base.metrics[.headHeight]) - middle
        let noseY = 0.75 - height * 0.4
        let score = scorer.score(PostureMetrics(sample: postureSample(noseY: noseY)), against: base)
        let drop = try XCTUnwrap(score.signals.first { $0.kind == .headDrop })
        XCTAssertFalse(drop.isBad)
        XCTAssertFalse(drop.isClear)
    }

    func testSensitivityBendsStrengthNotDetection() throws {
        let base = try baseline()
        let reading = PostureMetrics(sample: postureSample(noseY: 0.5))
        let gentle = PostureScorer(sensitivity: .gentle).score(reading, against: base)
        let aggressive = PostureScorer(sensitivity: .aggressive).score(reading, against: base)
        XCTAssertEqual(gentle.isBad, aggressive.isBad)
        XCTAssertEqual(gentle.severity, aggressive.severity, accuracy: 1e-12)
        XCTAssertGreaterThan(gentle.severity, 0)
        XCTAssertLessThan(gentle.severity, 1)
        XCTAssertLessThan(gentle.strength, aggressive.strength)
        // Dorso: strength = severity ^ (1 / exponent).
        XCTAssertEqual(aggressive.strength, pow(aggressive.severity, 1 / 1.2), accuracy: 1e-12)
    }

    func testForwardHeadAndLeanInAndTiltAndLateralEachTrigger() throws {
        let base = try baseline()
        let scorer = PostureScorer()
        XCTAssertEqual(scorer.score(PostureMetrics(sample: postureSample(eyeSpan: 0.13)), against: base).worst, .forwardHead)
        XCTAssertEqual(scorer.score(PostureMetrics(sample: postureSample(noseY: 0.4, shoulderWidth: 0.5, eyeSpan: 0.125)),
                                    against: base).worst, .leanIn)
        XCTAssertEqual(scorer.score(PostureMetrics(sample: postureSample(shoulderTilt: 0.1)), against: base).worst, .shoulderTilt)
        XCTAssertEqual(scorer.score(PostureMetrics(sample: postureSample(noseX: 0.62)), against: base).worst, .lateralLean)
    }

    /// Debug recording 2026-10-15 19:35 (Office): an upright sitter, face the size of the baseline, 3D shoulders
    /// estimated below a low camera's frame at 0.445 image heights against 0.630. The face-to-shoulder ratio rose 49%
    /// and the app said "head forward" for the whole recording. The face did not grow, so the head did not come forward.
    func testAFaceToShoulderRatioWithoutAGrowingFaceIsNotAForwardHead() {
        let base = PostureBaseline(
            metrics: PostureMetrics([.faceWidth: 0.3686, .faceWidthRatio: 0.5881, .shoulderWidth: 0.6298]),
            tolerance: PostureMetrics([.faceWidth: 0.05, .faceWidthRatio: 0.09, .shoulderWidth: 0.12]),
            span: PostureMetrics([.faceWidth: 0.15, .faceWidthRatio: 0.15, .shoulderWidth: 0.2])
        )
        let scorer = PostureScorer(enabled: [.forwardHead])
        let wrongShoulders = PostureMetrics([.faceWidth: 0.3886, .faceWidthRatio: 0.874, .shoulderWidth: 0.4446])
        XCTAssertFalse(scorer.score(wrongShoulders, against: base).isBad, "face +5%: not a forward head")

        // A real forward head: the face grows a quarter and the ratio with it.
        let forward = PostureMetrics([.faceWidth: 0.46, .faceWidthRatio: 0.74, .shoulderWidth: 0.62])
        XCTAssertEqual(scorer.score(forward, against: base).worst, .forwardHead)
    }

    /// eve on #529: calibration measured the forward-head span with the uncapped ratio, scoring with the ratio capped by
    /// face growth, so the slouch the user calibrated (face +10%, ratio +37.5%) scored about 0.005 instead of 1.
    func testACalibratedForwardHeadSlouchScoresAsTheFullSlouch() throws {
        let upright = (0..<6).map { index in
            let wobble = Double(index % 3 - 1) * 0.002
            return PostureMetrics([.faceWidth: 0.2 + wobble, .faceWidthRatio: 0.5 + wobble, .shoulderWidth: 0.4])
        }
        let slouch = Array(repeating: PostureMetrics([.faceWidth: 0.22, .faceWidthRatio: 0.6875, .shoulderWidth: 0.32]),
                           count: 4)
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: upright, slouch: slouch))
        let scorer = PostureScorer(enabled: [.forwardHead])

        let score = scorer.score(slouch[0], against: base)
        let signal = try XCTUnwrap(score.signals.first { $0.kind == .forwardHead })
        XCTAssertEqual(signal.measure, .faceWidthRatio)
        XCTAssertTrue(score.isBad)
        XCTAssertEqual(signal.severity, 1, accuracy: 0.01, "the calibrated slouch is the full slouch")
        XCTAssertFalse(scorer.score(upright[0], against: base).isBad)
    }

    func testADisabledFaultIsNotScored() throws {
        let base = try baseline()
        let scorer = PostureScorer(enabled: [.forwardHead])
        let score = scorer.score(PostureMetrics(sample: postureSample(noseY: 0.6)), against: base)
        XCTAssertFalse(score.isBad)
        XCTAssertEqual(score.signals.map(\.kind), [.forwardHead])
    }

    func testFaceOnlyReadingsScoreAgainstAFaceBaseline() throws {
        func face(_ y: Double, width: Double = 0.2) -> PoseSample {
            PoseSample(time: 0, engine: .visionFace,
                       face: PoseFace(box: CGRect(x: 0.4, y: y, width: width, height: width), confidence: 0.9, roll: 0, pitch: 0.05))
        }
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<5).map { _ in PostureMetrics(sample: face(0.3)) }))
        let scorer = PostureScorer()
        XCTAssertFalse(scorer.score(PostureMetrics(sample: face(0.3)), against: base).isBad)
        XCTAssertEqual(scorer.score(PostureMetrics(sample: face(0.4)), against: base).worst, .headDrop)
        XCTAssertEqual(scorer.score(PostureMetrics(sample: face(0.3, width: 0.24)), against: base).worst, .forwardHead)
    }

    /// A body-pose reading that lost the shoulders keeps only the face width for Forward head (live run 2026-10-14:
    /// a face 25% wider while upright held a slouch on).
    func testForwardHeadWithoutShouldersNeedsThemOrAWideFaceTolerance() throws {
        func body(faceWidth: Double) -> PostureMetrics {
            PostureMetrics(sample: PoseSample(time: 0, engine: .visionBody,
                                              joints: [.nose: PoseJointPoint(x: 0.5, y: 0.45, confidence: 0.9)],
                                              face: PoseFace(box: CGRect(x: 0.4, y: 0.3, width: faceWidth, height: faceWidth),
                                                             confidence: 0.9, roll: 0, pitch: 0.05)))
        }
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<5).map { _ in body(faceWidth: 0.2) }))
        let closer = body(faceWidth: 0.25)

        let needs = PostureScorer(forwardHeadWithoutShoulders: .needsShoulders).score(closer, against: base)
        XCTAssertFalse(needs.signals.contains { $0.kind == .forwardHead })
        XCTAssertEqual(needs.unjudged, [.forwardHead])
        XCTAssertFalse(needs.isBad)

        let face = PostureScorer(forwardHeadWithoutShoulders: .faceSize)
        let wide = try XCTUnwrap(face.score(closer, against: base).signals.first { $0.kind == .forwardHead })
        XCTAssertGreaterThanOrEqual(wide.enterThreshold, PostureForwardHeadFallback.faceOnlyTolerance)
        XCTAssertTrue(wide.isBad, "a quarter wider is past a fifth")
        XCTAssertFalse(face.score(body(faceWidth: 0.23), against: base).isBad, "15% wider is inside the wide tolerance")

        XCTAssertTrue(PostureScorer().score(closer, against: base).isBad, "nil keeps the calibrated tolerance")
    }

    func testHeadphonePitchUsesDorsosThreshold() throws {
        func pitch(_ value: Double) -> PostureMetrics {
            PostureMetrics(sample: PoseSample(time: 0, engine: .headphones, headphonePitch: value))
        }
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in pitch(0) }))
        let scorer = PostureScorer(deadZone: .strict)
        // 0.15 rad base tolerance: 0.14 is fine, 0.2 is bad, leaning back never is.
        XCTAssertFalse(scorer.score(pitch(0.14), against: base).isBad)
        XCTAssertTrue(scorer.score(pitch(0.2), against: base).isBad)
        XCTAssertFalse(scorer.score(pitch(-0.5), against: base).isBad)
    }

    func testCalibrationNeedsFourReadingsAndUsesTheSlouchSampleAsTheRange() throws {
        let upright = (0..<3).map { _ in PostureMetrics(sample: postureSample()) }
        XCTAssertNil(PostureBaseline.calibrate(upright: upright))
        let more = upright + [PostureMetrics(sample: postureSample())]
        let slouch = [PostureMetrics(sample: postureSample(noseY: 0.6))]
        let base = try XCTUnwrap(PostureBaseline.calibrate(upright: more, slouch: slouch))
        // The slouch sample sits at severity 1: drift 0.375, tolerance 0.04, span 0.335.
        XCTAssertEqual(try XCTUnwrap(base.span[.headHeight]), 0.375 - 0.04, accuracy: 1e-9)
        let atSlouch = PostureScorer(deadZone: .strict).score(PostureMetrics(sample: postureSample(noseY: 0.6)), against: base)
        XCTAssertEqual(atSlouch.severity, 1, accuracy: 1e-9)
    }

    func testLookingAroundWidensTheTolerance() throws {
        let still = try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: postureSample()) }))
        let looking = try XCTUnwrap(PostureBaseline.calibrate(upright: [0.45, 0.45, 0.45, 0.47, 0.48].map {
            PostureMetrics(sample: postureSample(noseY: $0))
        }))
        XCTAssertEqual(try XCTUnwrap(still.tolerance[.headHeight]), 0.04, accuracy: 1e-9)
        XCTAssertGreaterThan(try XCTUnwrap(looking.tolerance[.headHeight]), 0.07)
    }

    func testTheSmootherTakesTheMedianInsideItsWindow() {
        var smoother = PostureSmoother(window: 1, maxCount: 5)
        _ = smoother.add(PostureMetrics([.headHeight: 0.7]), at: 0)
        _ = smoother.add(PostureMetrics([.headHeight: 0.1]), at: 0.2)
        let median = smoother.add(PostureMetrics([.headHeight: 0.72]), at: 0.4)
        XCTAssertEqual(median[.headHeight], 0.7)
        // Two seconds later the old readings are gone.
        XCTAssertEqual(smoother.add(PostureMetrics([.headHeight: 0.3]), at: 2.5)[.headHeight], 0.3)
    }

    func testMetricsAndSamplesRoundTripThroughJSON() throws {
        let sample = postureSample(time: 12)
        let decoded = try JSONDecoder().decode(PoseSample.self, from: JSONEncoder().encode(sample))
        XCTAssertEqual(decoded, sample)
        let base = try baseline()
        XCTAssertEqual(try JSONDecoder().decode(PostureBaseline.self, from: JSONEncoder().encode(base)), base)
        let json = String(decoding: try JSONEncoder().encode(PostureMetrics([.headHeight: 0.5])), as: UTF8.self)
        XCTAssertTrue(json.contains("\"headHeight\""), json)
    }

    /// Item 31: horizontal distances are scaled by the image aspect, so lengths are in image heights and
    /// angles are true angles.
    func testHorizontalDistancesUseTheImageAspect() throws {
        let tilted = PoseSample(time: 0, engine: .visionBody, joints: [
            .leftShoulder: PoseJointPoint(x: 0.65, y: 0.75, confidence: 0.9),
            .rightShoulder: PoseJointPoint(x: 0.35, y: 0.65, confidence: 0.9),
        ], imageAspect: 16.0 / 9.0)
        let metrics = PostureMetrics(sample: tilted)
        XCTAssertEqual(try XCTUnwrap(metrics[.shoulderWidth]), hypot(0.3 * 16 / 9, 0.1), accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(metrics[.shoulderTilt]), atan2(0.1, 0.3 * 16 / 9), accuracy: 1e-9)
    }

    /// M19: shoulders without a head are a person (a head bent out of the frame), and they score as a
    /// full head drop rather than as nobody there.
    func testShouldersWithoutAHeadAreAFullHeadDrop() throws {
        let headless = PoseSample(time: 0, engine: .visionBody, joints: [
            .leftShoulder: PoseJointPoint(x: 0.7, y: 0.75, confidence: 0.9),
            .rightShoulder: PoseJointPoint(x: 0.3, y: 0.75, confidence: 0.9),
        ], imageAspect: 1)
        XCTAssertTrue(headless.hasPerson)
        XCTAssertFalse(PoseSample(time: 0, engine: .visionBody, joints: [
            .leftShoulder: PoseJointPoint(x: 0.7, y: 0.75, confidence: 0.9),
        ]).hasPerson)
        let score = PostureScorer().score(PostureMetrics(sample: headless), against: try baseline())
        XCTAssertTrue(score.isBad)
        XCTAssertEqual(score.worst, .headDrop)
        XCTAssertEqual(score.signals.first { $0.kind == .headDrop }?.severity, 1)
    }

    func testAnAlertGivesTheDriftInShoulderWidthsAndAnEstimate() throws {
        let base = try baseline()
        let score = PostureScorer().score(PostureMetrics(sample: postureSample(noseY: 0.6)), against: base)
        let alert = try XCTUnwrap(PostureAlert(score: score, baseline: base, date: Date(timeIntervalSince1970: 0)))
        XCTAssertEqual(alert.kind, .headDrop)
        XCTAssertEqual(alert.unit, .shoulderWidths)
        XCTAssertEqual(try XCTUnwrap(alert.approximateCentimeters(shoulderWidthCM: 40)), alert.deviation * 40, accuracy: 1e-9)
        XCTAssertNil(alert.degrees)
        XCTAssertNil(PostureAlert(score: PostureScorer().score(PostureMetrics(sample: postureSample()), against: base),
                                  baseline: base, date: Date()), "upright has no alert")
        let tilt = PostureAlert(kind: .shoulderTilt, measure: .shoulderTilt, deviation: .pi / 18, unit: .radians,
                                severity: 0.5, strength: 0.5, rangeFraction: 0.5)
        XCTAssertEqual(try XCTUnwrap(tilt.degrees), 10, accuracy: 1e-9)
        XCTAssertNil(tilt.approximateCentimeters())
    }
}
