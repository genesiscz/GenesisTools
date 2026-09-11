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
}
