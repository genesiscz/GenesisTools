import CoreGraphics
import Foundation
import XCTest
@testable import SnapshotSupport

private func signature(width: Int, height: Int, fill: (Int, Int) -> UInt8) -> FrameSignature {
    let bytesPerRow = width * 4 + 64
    var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
    for y in 0..<height {
        for x in 0..<width {
            let value = fill(x, y)
            let offset = y * bytesPerRow + x * 4
            bytes[offset] = value
            bytes[offset + 1] = value
            bytes[offset + 2] = value
            bytes[offset + 3] = 255
        }
    }
    return bytes.withUnsafeBytes { raw in
        FrameSignature(bgra: raw.baseAddress!, width: width, height: height, bytesPerRow: bytesPerRow, stride: 4)
    }
}

private func inside(_ x: Int, _ y: Int, _ rect: (Int, Int, Int, Int)) -> Bool {
    x >= rect.0 && x < rect.0 + rect.2 && y >= rect.1 && y < rect.1 + rect.3
}

final class MotionBoxTests: XCTestCase {
    // 4 px sampling stride and 4x4 sample blocks: one block is 16x16 output pixels.
    func testOneChangedPatchGivesOneBoxInOutputPixels() {
        let before = signature(width: 128, height: 64) { _, _ in 0 }
        let after = signature(width: 128, height: 64) { x, y in inside(x, y, (40, 20, 10, 10)) ? 255 : 0 }
        XCTAssertEqual(after.motionBoxes(from: before), [MotionBox(x: 32, y: 16, width: 32, height: 16)])
    }

    func testSeparatePatchesStaySeparateAndTheLargestComesFirst() {
        let before = signature(width: 256, height: 128) { _, _ in 0 }
        let after = signature(width: 256, height: 128) { x, y in
            inside(x, y, (0, 0, 8, 8)) || inside(x, y, (160, 64, 48, 32)) ? 255 : 0
        }
        XCTAssertEqual(after.motionBoxes(from: before), [
            MotionBox(x: 160, y: 64, width: 48, height: 32),
            MotionBox(x: 0, y: 0, width: 16, height: 16),
        ])
    }

    func testNoChangeGivesNoBoxAndOtherSizesGiveTheWholeFrame() {
        let flat = signature(width: 64, height: 64) { _, _ in 10 }
        XCTAssertEqual(flat.motionBoxes(from: flat), [])
        let other = signature(width: 32, height: 64) { _, _ in 10 }
        XCTAssertEqual(flat.motionBoxes(from: other), [MotionBox(x: 0, y: 0, width: 64, height: 64)])
    }

    func testABoxIsClippedToTheFrame() {
        let before = signature(width: 72, height: 40) { _, _ in 0 }
        let after = signature(width: 72, height: 40) { x, y in x >= 64 && y >= 32 ? 255 : 0 }
        XCTAssertEqual(after.motionBoxes(from: before), [MotionBox(x: 64, y: 32, width: 8, height: 8)])
    }

    func testAtMostEightBoxesAndTheClosestOnesMergeFirst() {
        // Twelve isolated single blocks on a 32-block grid, two blocks apart.
        let before = signature(width: 512, height: 64) { _, _ in 0 }
        let after = signature(width: 512, height: 64) { x, y in
            y < 16 && (x / 16) % 2 == 0 && x / 16 < 24 && (x / 16) % 4 == 0 ? 255 : 0
        }
        let raw = after.motionBoxes(from: before, maxBoxes: 100)
        XCTAssertEqual(raw.count, 6)
        let many = signature(width: 512, height: 64) { x, y in y < 16 && (x / 16) % 2 == 0 && x / 16 < 24 ? 255 : 0 }
        let boxes = many.motionBoxes(from: before)
        XCTAssertEqual(boxes.count, 8)
        let covered = boxes.reduce(0) { $0 + $1.width * $1.height }
        XCTAssertLessThanOrEqual(covered, 24 * 16 * 16)
        for column in stride(from: 0, to: 24, by: 2) {
            XCTAssertTrue(boxes.contains { $0.x <= column * 16 && $0.x + $0.width >= column * 16 + 16 },
                          "block \(column) is still covered after merging")
        }
    }

    func testMergeFoldsOverlappingRegions() {
        let merged = mergeMotionRegions([
            BlockRect(minX: 0, minY: 0, maxX: 2, maxY: 2),
            BlockRect(minX: 2, minY: 2, maxX: 4, maxY: 4),
            BlockRect(minX: 10, minY: 10, maxX: 10, maxY: 10),
        ], maxBoxes: 8)
        XCTAssertEqual(merged, [BlockRect(minX: 0, minY: 0, maxX: 4, maxY: 4), BlockRect(minX: 10, minY: 10, maxX: 10, maxY: 10)])
    }

    func testAKeptChangeCarriesBoxesAndFirstAndHeartbeatFramesDoNot() {
        let dark = signature(width: 64, height: 64) { _, _ in 0 }
        let patch = signature(width: 64, height: 64) { x, y in inside(x, y, (0, 0, 16, 16)) ? 255 : 0 }
        var policy = KeepPolicy(thresholdPercent: 1)
        XCTAssertEqual(policy.consider(dark).motionBoxes, [])
        let change = policy.consider(patch)
        XCTAssertEqual(change.reason, "change")
        XCTAssertEqual(change.motionBoxes, [MotionBox(x: 0, y: 0, width: 16, height: 16)])
        let beat = policy.heartbeat(patch)
        XCTAssertEqual(beat?.reason, "heartbeat")
        XCTAssertEqual(beat?.motionBoxes, [])
        XCTAssertEqual(beat?.moved, false, "a heartbeat is not motion, so the rate stays idle")
    }
}

final class CaptureCapTests: XCTestCase {
    func testMaxBytesStopsKeepingButStillMeasuresMotion() {
        let dark = signature(width: 16, height: 16) { _, _ in 0 }
        let light = signature(width: 16, height: 16) { _, _ in 255 }
        var policy = KeepPolicy(thresholdPercent: 10, maxFrames: 800, maxBytes: maxBytes(megabytes: 1))
        XCTAssertEqual(policy.maxBytes, 1_048_576)
        XCTAssertTrue(policy.consider(dark).keep)
        policy.noteWritten(bytes: 600_000)
        XCTAssertTrue(policy.consider(light).keep)
        policy.noteWritten(bytes: 600_000)
        XCTAssertTrue(policy.capReached)
        let past = policy.consider(dark)
        XCTAssertEqual(past, KeepPolicy.Decision(keep: false, changePercent: 100, reason: "cap", moved: true))
        XCTAssertNil(policy.heartbeat(dark), "no heartbeat past the cap")
    }

    func testNoByteCapWithoutTheFlag() {
        XCTAssertNil(maxBytes(megabytes: nil))
        XCTAssertNil(maxBytes(megabytes: 0))
        var policy = KeepPolicy(thresholdPercent: 10)
        policy.noteWritten(bytes: Int.max / 2)
        XCTAssertFalse(policy.capReached)
    }

    func testLongSideCapKeepsTheAspectRatioAndEvenSizesForH264() {
        XCTAssertEqual(capLongSide(CGSize(width: 3024, height: 1964), maxLongSide: 1280, even: false),
                       CGSize(width: 1280, height: 831))
        XCTAssertEqual(capLongSide(CGSize(width: 3024, height: 1964), maxLongSide: 1280, even: true),
                       CGSize(width: 1280, height: 830))
        XCTAssertEqual(capLongSide(CGSize(width: 1000, height: 2000), maxLongSide: 500, even: false),
                       CGSize(width: 250, height: 500))
        XCTAssertEqual(capLongSide(CGSize(width: 800, height: 600), maxLongSide: 1280, even: false),
                       CGSize(width: 800, height: 600), "a smaller frame is never scaled up")
        XCTAssertEqual(capLongSide(CGSize(width: 801, height: 600), maxLongSide: nil, even: true),
                       CGSize(width: 800, height: 600))
    }
}

final class HeartbeatAndQuietTests: XCTestCase {
    func testHeartbeatIsDueAfterTheIntervalAndOffAtZero() {
        let beat = HeartbeatPolicy(seconds: 2)
        XCTAssertFalse(beat.due(nowMs: 5000, lastKeptMs: nil), "nothing to repeat before the first frame")
        XCTAssertFalse(beat.due(nowMs: 1999, lastKeptMs: 0))
        XCTAssertTrue(beat.due(nowMs: 2000, lastKeptMs: 0))
        XCTAssertFalse(HeartbeatPolicy(seconds: 0).due(nowMs: 99_999, lastKeptMs: 0))
        XCTAssertFalse(HeartbeatPolicy(seconds: 0).enabled)
    }

    func testHeartbeatCountsTowardsTheFrameCap() {
        let dark = signature(width: 16, height: 16) { _, _ in 0 }
        var policy = KeepPolicy(thresholdPercent: 10, maxFrames: 2)
        XCTAssertNil(policy.heartbeat(dark), "no heartbeat before a first frame")
        XCTAssertTrue(policy.consider(dark).keep)
        XCTAssertNotNil(policy.heartbeat(dark))
        XCTAssertNil(policy.heartbeat(dark))
    }

    func testDefaultQuietTimeIsEightFramesAtTheActiveRate() {
        XCTAssertEqual(FrameRatePolicy.defaultQuietMs(activeFps: 8), 1000)
        XCTAssertEqual(FrameRatePolicy.defaultQuietMs(activeFps: 1), 8000)
        XCTAssertEqual(FrameRatePolicy.defaultQuietMs(activeFps: 60), 133)
    }

    func testQuietTimeDropsToIdleByTimeNotByFrameCount() {
        var rate = FrameRatePolicy(activeFps: 1, idleFps: 0.2, quietMs: 3000)
        XCTAssertNil(rate.observe(kept: true, atMs: 0), "the first frame starts at the active rate")
        XCTAssertNil(rate.observe(kept: false, atMs: 1000))
        XCTAssertNil(rate.observe(kept: false, atMs: 2999))
        XCTAssertEqual(rate.observe(kept: false, atMs: 3000), 0.2)
        XCTAssertNil(rate.observe(kept: false, atMs: 9000), "already idle")
        XCTAssertEqual(rate.observe(kept: true, atMs: 9500), 1, "one moved frame returns to the active rate")
        XCTAssertNil(rate.observe(kept: false, atMs: 12_000))
        XCTAssertEqual(rate.observe(kept: false, atMs: 12_500), 0.2)
    }

    func testWithoutQuietTimeTheTimedObserveKeepsTheFrameCountRule() {
        var rate = FrameRatePolicy(activeFps: 8, idleFps: 2, stillFramesBeforeIdle: 2)
        XCTAssertNil(rate.observe(kept: false, atMs: 0))
        XCTAssertEqual(rate.observe(kept: false, atMs: 1), 2)
    }
}

final class DisplayChangeTests: XCTestCase {
    private let recorded: CGDirectDisplayID = 3

    func testRemovingTheRecordedDisplayEndsOrSwitches() {
        XCTAssertEqual(displayChangeAction(changed: recorded, flags: .removeFlag, recorded: recorded, followFocus: false), .end)
        XCTAssertEqual(displayChangeAction(changed: recorded, flags: .removeFlag, recorded: recorded, followFocus: true), .switchToFocus)
        XCTAssertEqual(displayChangeAction(changed: recorded, flags: .disabledFlag, recorded: recorded, followFocus: false), .end)
    }

    func testOtherDisplaysAndTheBeginPassAreIgnored() {
        XCTAssertEqual(displayChangeAction(changed: 7, flags: .removeFlag, recorded: recorded, followFocus: false), .ignore)
        XCTAssertEqual(displayChangeAction(changed: recorded, flags: [.beginConfigurationFlag, .removeFlag],
                                           recorded: recorded, followFocus: false), .ignore)
        XCTAssertEqual(displayChangeAction(changed: recorded, flags: [.movedFlag, .desktopShapeChangedFlag],
                                           recorded: recorded, followFocus: false), .ignore)
        XCTAssertEqual(displayChangeAction(changed: recorded, flags: .addFlag, recorded: recorded, followFocus: true), .ignore)
    }

    func testEarlyEndPrefersTheRemovedDisplayThenTheStreamError() {
        XCTAssertEqual(captureEarlyEnd(cancelled: true, displayRemoved: true, streamFailed: true), .displayRemoved)
        XCTAssertEqual(captureEarlyEnd(cancelled: true, displayRemoved: false, streamFailed: true), .streamError)
        XCTAssertEqual(captureEarlyEnd(cancelled: true, displayRemoved: false, streamFailed: false), .stopped)
        XCTAssertNil(captureEarlyEnd(cancelled: false, displayRemoved: false, streamFailed: false))
        XCTAssertEqual(CaptureEarlyEnd.displayRemoved.rawValue, "display-removed")
        XCTAssertEqual(CaptureEarlyEnd.streamError.rawValue, "stream-error")
    }

    func testFocusDisplayFollowsTheWindowThenTheMouse() {
        let displays = [
            DisplayFrame(id: 1, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982)),
            DisplayFrame(id: 2, bounds: CGRect(x: 1512, y: -200, width: 2560, height: 1440)),
        ]
        XCTAssertEqual(focusDisplay(window: CGRect(x: 1400, y: 100, width: 800, height: 600), mouse: CGPoint(x: 10, y: 10),
                                    displays: displays), 2, "the display holding most of the window wins over the mouse")
        XCTAssertEqual(focusDisplay(window: nil, mouse: CGPoint(x: 2000, y: 0), displays: displays), 2)
        XCTAssertEqual(focusDisplay(window: CGRect(x: -5000, y: 0, width: 10, height: 10), mouse: CGPoint(x: 5, y: 5),
                                    displays: displays), 1, "a window on no display falls back to the mouse")
        XCTAssertEqual(focusDisplay(window: nil, mouse: nil, displays: displays), 1)
        XCTAssertNil(focusDisplay(window: nil, mouse: nil, displays: []))
    }
}
