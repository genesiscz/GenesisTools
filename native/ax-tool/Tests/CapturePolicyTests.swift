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
    func testFragmentedChangesHaveBoundedReductionAndKeepEveryRegion() {
        let regions = (0..<10_000).map { BlockRect(minX: $0 * 2, minY: 0, maxX: $0 * 2, maxY: 0) }
        XCTAssertEqual(mergeMotionRegions(regions, maxBoxes: 8), [BlockRect(minX: 0, minY: 0, maxX: 19_998, maxY: 0)])
    }

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

    func testFollowingTakesWhicheverMovedLastThePointerOrTheFocus() {
        var state = FollowState()
        XCTAssertEqual(state.next(pointer: 1, focus: 2), 1, "the first tick takes the pointer's display")
        XCTAssertEqual(state.next(pointer: 1, focus: 2), 1, "nothing moved, so it stays")
        XCTAssertEqual(state.next(pointer: 1, focus: 1), 1)
        XCTAssertEqual(state.next(pointer: 1, focus: 2), 2, "a window on display 2 took the focus")
        XCTAssertEqual(state.next(pointer: 1, focus: 2), 2, "the pointer did not move, so the focus's display stays")
        XCTAssertEqual(state.next(pointer: 2, focus: 2), 2)
        XCTAssertEqual(state.next(pointer: 1, focus: 2), 1, "the pointer went back to display 1")
        XCTAssertEqual(state.next(pointer: nil, focus: 2), 1, "a pointer on no display changes nothing")
        let displays = [DisplayFrame(id: 1, bounds: CGRect(x: 0, y: 0, width: 100, height: 100))]
        XCTAssertEqual(displayUnder(CGPoint(x: 50, y: 50), displays: displays), 1)
        XCTAssertNil(displayUnder(CGPoint(x: 500, y: 50), displays: displays))
    }
}

final class CaptureCommandTests: XCTestCase {
    func testParsesEachCommand() throws {
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"switch","displayId":4}"#)?.get(), .switchDisplay(4))
        XCTAssertEqual(try parseCaptureCommand(#" {"cmd":"pause"} "#)?.get(), .pause)
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"resume"}"#)?.get(), .resume)
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"stop"}"#)?.get(), .stop)
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"status"}"#)?.get(), .status)
        XCTAssertNil(parseCaptureCommand("   "), "a blank line is no command")
    }

    func testRefusesMalformedCommands() {
        for line in ["not json", #"{"displayId":4}"#, #"{"cmd":"switch"}"#, #"{"cmd":"switch","displayId":0}"#,
                     #"{"cmd":"switch","displayId":1.5}"#, #"{"cmd":"switch","displayId":"4"}"#, #"{"cmd":"rewind"}"#] {
            guard case .failure = parseCaptureCommand(line) else {
                XCTFail("\(line) must be refused")
                continue
            }
        }
    }
}

final class DisplayScaleTests: XCTestCase {
    func testScaleIsBackingPixelsPerPoint() {
        XCTAssertEqual(displayScale(pixelWidth: 4112, pointWidth: 2056), 2)
        XCTAssertEqual(displayScale(pixelWidth: 2560, pointWidth: 2560), 1)
        XCTAssertEqual(displayScale(pixelWidth: 0, pointWidth: 2056), 1)
        XCTAssertEqual(displayScale(pixelWidth: 3024, pointWidth: 0), 1)
    }
}

final class AudioCommandTests: XCTestCase {
    func testParsesTheAudioAndSettingsCommands() throws {
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"mute","source":"mic"}"#)?.get(), .mute(.mic))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"unmute","source":"system"}"#)?.get(), .unmute(.system))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-mic","deviceId":"BuiltInMicrophoneDevice"}"#)?.get(),
                       .setMic("BuiltInMicrophoneDevice"))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-fps","active":4}"#)?.get(), .setFps(active: 4, idle: nil))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-fps","active":8,"idle":0.5}"#)?.get(), .setFps(active: 8, idle: 0.5))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-threshold","percent":1.5}"#)?.get(), .setThreshold(1.5))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-max-long-side","px":1280}"#)?.get(), .setMaxLongSide(1280))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-max-long-side","px":0}"#)?.get(), .setMaxLongSide(nil))
        XCTAssertEqual(try parseCaptureCommand(#"{"cmd":"set-max-long-side","px":null}"#)?.get(), .setMaxLongSide(nil))
    }

    func testRefusesOutOfRangeSettings() {
        for line in [#"{"cmd":"mute","source":"speaker"}"#, #"{"cmd":"mute"}"#, #"{"cmd":"set-mic","deviceId":""}"#,
                     #"{"cmd":"set-fps"}"#, #"{"cmd":"set-fps","active":200}"#, #"{"cmd":"set-fps","idle":9}"#,
                     #"{"cmd":"set-fps","active":true}"#, #"{"cmd":"set-threshold","percent":101}"#,
                     #"{"cmd":"set-max-long-side","px":8}"#, #"{"cmd":"set-max-long-side","px":100.5}"#] {
            guard case .failure = parseCaptureCommand(line) else {
                XCTFail("\(line) must be refused")
                continue
            }
        }
    }

    func testAudioSourcesAndPeaks() {
        XCTAssertEqual(try parseAudioSources("system,mic").get(), [.system, .mic])
        XCTAssertEqual(try parseAudioSources("mic, mic").get(), [.mic])
        XCTAssertThrowsError(try parseAudioSources("system,radio").get())
        XCTAssertThrowsError(try parseAudioSources("").get())
        let floats: [Float] = [0.1, -0.5, 0.25, .nan]
        XCTAssertEqual(floats.withUnsafeBufferPointer { peakAmplitude(float32: $0) }, 0.5)
        let ints: [Int16] = [100, -16384, 200]
        XCTAssertEqual(ints.withUnsafeBufferPointer { peakAmplitude(int16: $0) }, 0.5)
        XCTAssertEqual(peakDbfs(0.5), -6)
        XCTAssertEqual(peakDbfs(1), 0)
        XCTAssertNil(peakDbfs(0), "digital silence has no dB value")
    }

    func testAudioFileMetadataExcludesPausedAndDroppedSamples() {
        var timeline = AudioFileTimeline()
        // 2.55 s audible, a pause with no appended samples, then 3 s of silence and 2.066 s audible.
        timeline.append(sampleCount: 122_400, sampleRate: 48_000, muted: false)
        timeline.append(sampleCount: 48_000, sampleRate: 48_000, muted: true)
        timeline.append(sampleCount: 96_000, sampleRate: 48_000, muted: true)
        timeline.append(sampleCount: 99_168, sampleRate: 48_000, muted: false)
        XCTAssertEqual(timeline.durationMs, 7_616)
        XCTAssertEqual(timeline.mutedSpans, [[2_550, 5_550]])
        timeline.append(sampleCount: 0, sampleRate: 48_000, muted: true)
        XCTAssertEqual(timeline.durationMs, 7_616)
        XCTAssertEqual(timeline.mutedSpans, [[2_550, 5_550]])
    }

    func testAudioFileMetadataWithoutPausesAndWithSeparateMuteIntervals() {
        var timeline = AudioFileTimeline()
        for muted in [false, true, false, true] {
            timeline.append(sampleCount: 48_000, sampleRate: 48_000, muted: muted)
        }
        XCTAssertEqual(timeline.durationMs, 4_000)
        XCTAssertEqual(timeline.mutedSpans, [[1_000, 2_000], [3_000, 4_000]])
    }

    func testThresholdChangesLive() {
        let dark = signature(width: 16, height: 16) { _, _ in 0 }
        let half = signature(width: 16, height: 16) { x, _ in x < 4 ? 255 : 0 }
        var policy = KeepPolicy(thresholdPercent: 50)
        XCTAssertTrue(policy.consider(dark).keep)
        XCTAssertFalse(policy.consider(half).keep)
        policy.setThreshold(10)
        XCTAssertTrue(policy.consider(half).keep)
    }
}
