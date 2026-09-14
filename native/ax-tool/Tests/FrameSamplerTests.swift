import Foundation
import XCTest
@testable import SnapshotSupport

private func frame(width: Int, height: Int, fill: (Int, Int) -> (UInt8, UInt8, UInt8)) -> [UInt8] {
    // A padded row pitch, like a real IOSurface-backed CVPixelBuffer on Apple silicon.
    let bytesPerRow = width * 4 + 64
    var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
    for y in 0..<height {
        for x in 0..<width {
            let (b, g, r) = fill(x, y)
            let offset = y * bytesPerRow + x * 4
            bytes[offset] = b
            bytes[offset + 1] = g
            bytes[offset + 2] = r
            bytes[offset + 3] = 255
        }
    }
    return bytes
}

private func signature(_ bytes: [UInt8], width: Int, height: Int) -> FrameSignature {
    bytes.withUnsafeBytes { raw in
        FrameSignature(bgra: raw.baseAddress!, width: width, height: height, bytesPerRow: width * 4 + 64, stride: 4)
    }
}

final class FrameSamplerTests: XCTestCase {
    func testIdenticalFramesDoNotChange() {
        let a = signature(frame(width: 64, height: 32) { _, _ in (10, 20, 30) }, width: 64, height: 32)
        let b = signature(frame(width: 64, height: 32) { _, _ in (10, 20, 30) }, width: 64, height: 32)
        XCTAssertEqual(a.width, 16)
        XCTAssertEqual(a.height, 8)
        XCTAssertEqual(b.changePercent(from: a), 0)
    }

    func testHalfTheFrameChangingReadsAsFiftyPercent() {
        let a = signature(frame(width: 64, height: 32) { _, _ in (0, 0, 0) }, width: 64, height: 32)
        let b = signature(frame(width: 64, height: 32) { x, _ in x < 32 ? (0, 0, 0) : (255, 255, 255) }, width: 64, height: 32)
        XCTAssertEqual(b.changePercent(from: a), 50, accuracy: 0.01)
    }

    func testSmallColourNoiseIsBelowTolerance() {
        let a = signature(frame(width: 64, height: 32) { _, _ in (100, 100, 100) }, width: 64, height: 32)
        let b = signature(frame(width: 64, height: 32) { _, _ in (120, 110, 90) }, width: 64, height: 32)
        XCTAssertEqual(b.changePercent(from: a), 0, "a delta of 20 is compression noise, not motion")
        XCTAssertEqual(b.changePercent(from: a, tolerance: 10), 100)
    }

    func testResizedFramesCountAsFullyChanged() {
        let a = signature(frame(width: 64, height: 32) { _, _ in (0, 0, 0) }, width: 64, height: 32)
        let b = signature(frame(width: 32, height: 32) { _, _ in (0, 0, 0) }, width: 32, height: 32)
        XCTAssertEqual(b.changePercent(from: a), 100)
    }

    func testKeepPolicyComparesAgainstTheLastKeptFrame() {
        var policy = KeepPolicy(thresholdPercent: 10)
        let dark = signature(frame(width: 64, height: 32) { _, _ in (0, 0, 0) }, width: 64, height: 32)
        XCTAssertEqual(policy.consider(dark), KeepPolicy.Decision(keep: true, changePercent: 100, reason: "first"))
        XCTAssertEqual(policy.consider(dark).reason, "still")
        // A slow fade: every step whitens one sampled column, 6.25 percent of the frame, so no
        // single step crosses the 10 percent threshold against its neighbour. Against the last
        // KEPT frame the change accumulates and crosses every second step.
        var previous = dark
        var neighbourDeltas: [Double] = []
        var kept = 0
        for step in 1...10 {
            let partial = signature(frame(width: 64, height: 32) { x, _ in x < step * 4 ? (255, 255, 255) : (0, 0, 0) }, width: 64, height: 32)
            neighbourDeltas.append(partial.changePercent(from: previous))
            previous = partial
            if policy.consider(partial).keep {
                kept += 1
            }
        }
        XCTAssertTrue(neighbourDeltas.allSatisfy { $0 < 10 }, "a neighbour comparison never crosses: \(neighbourDeltas)")
        XCTAssertEqual(kept, 5, "against the last kept frame the fade is sampled every second step")
        XCTAssertEqual(policy.keptCount, 6)
    }

    func testZeroThresholdKeepsEveryDifferentFrameAndCapHolds() {
        var policy = KeepPolicy(thresholdPercent: 0, maxFrames: 3)
        for shade in [UInt8(0), 60, 120, 180, 240] {
            _ = policy.consider(signature(frame(width: 16, height: 16) { _, _ in (shade, shade, shade) }, width: 16, height: 16))
        }
        XCTAssertEqual(policy.keptCount, 3)
        let again = policy.consider(signature(frame(width: 16, height: 16) { _, _ in (7, 7, 7) }, width: 16, height: 16))
        XCTAssertEqual(again.reason, "cap")
    }

    func testTheRatePolicyDropsToIdleOnlyAfterARunOfStillFrames() {
        var rate = FrameRatePolicy(activeFps: 8, idleFps: 2, stillFramesBeforeIdle: 3)
        XCTAssertEqual(rate.currentFps, 8)
        XCTAssertNil(rate.observe(kept: false), "one still frame is not an idle screen")
        XCTAssertNil(rate.observe(kept: false))
        XCTAssertEqual(rate.observe(kept: false), 2, "the third still frame drops to the idle rate")
        XCTAssertNil(rate.observe(kept: false), "already idle, so nothing changes")
        XCTAssertEqual(rate.currentFps, 2)
    }

    func testOneChangedFrameReturnsToTheActiveRateImmediately() {
        var rate = FrameRatePolicy(activeFps: 8, idleFps: 2, stillFramesBeforeIdle: 2)
        _ = rate.observe(kept: false)
        XCTAssertEqual(rate.observe(kept: false), 2)
        XCTAssertEqual(rate.observe(kept: true), 8, "the frame that ends a still stretch is the interesting one")
        // The still counter restarts, so a single change does not leave the stream one frame from idle.
        XCTAssertNil(rate.observe(kept: false))
        XCTAssertEqual(rate.observe(kept: false), 2)
    }

    func testAnIdleRateAboveTheActiveOneIsClamped() {
        var rate = FrameRatePolicy(activeFps: 4, idleFps: 30, stillFramesBeforeIdle: 1)
        XCTAssertEqual(rate.idleFps, 4)
        XCTAssertNil(rate.observe(kept: false), "there is no slower rate to move to")
    }

    func testAFractionalRateSurvivesAsAFrameInterval() {
        // CMTime(value: 1, timescale: Int32(0.1.rounded())) is a zero timescale, which clamps to
        // 1 fps — ten times faster than --idle-fps 0.1 asks for.
        let slow = frameInterval(fps: 0.1)
        XCTAssertEqual(Double(slow.value) / Double(slow.timescale), 10, accuracy: 0.001)
        let fast = frameInterval(fps: 8)
        XCTAssertEqual(Double(fast.value) / Double(fast.timescale), 0.125, accuracy: 0.001)
    }

    func testZeroThresholdStillRejectsAnUnchangedFrame() {
        var policy = KeepPolicy(thresholdPercent: 0, maxFrames: 100)
        let still = signature(frame(width: 16, height: 16) { _, _ in (40, 40, 40) }, width: 16, height: 16)
        XCTAssertEqual(policy.consider(still).reason, "first")
        // A recording of a motionless window would otherwise fill maxFrames with one picture.
        XCTAssertEqual(policy.consider(still), KeepPolicy.Decision(keep: false, changePercent: 0, reason: "still"))
        XCTAssertEqual(policy.keptCount, 1)
        let moved = signature(frame(width: 16, height: 16) { _, _ in (200, 200, 200) }, width: 16, height: 16)
        XCTAssertTrue(policy.consider(moved).keep, "any real change still passes at threshold 0")
    }
}
