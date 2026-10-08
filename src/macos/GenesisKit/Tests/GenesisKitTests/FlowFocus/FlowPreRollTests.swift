// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowPreRollTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AVFoundation
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// Pre-roll sizing and buffer copying. The engine itself needs a live
/// microphone, so what is tested here is the arithmetic and the memory
/// semantics — the two places a mistake silently costs the first word.
final class FlowPreRollTests: XCTestCase {

    @MainActor
    func testFailedSilentAndCancelledTurnsReturnTheMicToOptedInPreRoll() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-preroll-lifecycle-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = false
        config.preRoll = true
        store.saveConfig(config)
        let session = FlowSession(store: store)
        var rolling = false
        var recognitionStarts = 0
        session.preRollEffect = { rolling = $0 }
        session.hotkeyBindingEffect = {}
        session.recognitionStartEffect = {
            recognitionStarts += 1
            XCTAssertFalse(rolling, "the recognizer must own the device exclusively")
            throw CocoaError(.fileReadUnknown)
        }
        session.start()
        XCTAssertTrue(rolling)
        session.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(session.phase, .error)
        XCTAssertTrue(rolling, "failed recognition must resume opted-in pre-roll")
        session.recognitionStartEffect = {
            recognitionStarts += 1
            XCTAssertFalse(rolling)
        }
        session.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(session.phase, .listening)
        XCTAssertFalse(rolling)
        await session.completeTurn(raw: "  \n")
        XCTAssertEqual(session.phase, .idle)
        XCTAssertTrue(rolling, "silence must resume pre-roll for the next turn")
        session.beginTurn(captureCurrentTarget: false)
        session.cancelTurn()
        XCTAssertTrue(rolling, "cancelling a turn also returns ownership")
        session.beginTurn(captureCurrentTarget: false)
        session.config.preRoll = false
        session.config.preRoll = true
        XCTAssertFalse(rolling, "changing the setting cannot start a second engine during a turn")
        session.stop()
        XCTAssertFalse(rolling, "shutdown must not restart the microphone")
        session.cancelTurn()
        XCTAssertFalse(rolling)
        XCTAssertEqual(recognitionStarts, 4)
    }

    private func format(_ rate: Double, channels: AVAudioChannelCount = 1) -> AVAudioFormat {
        AVAudioFormat(standardFormatWithSampleRate: rate, channels: channels)!
    }

    // MARK: - Window sizing

    func testWindowCoversTheConfiguredDuration() {
        // 48 kHz / 1024 frames ≈ 46.9 buffers per second, so 0.6 s needs ~29.
        let count = FlowPreRoll.bufferCount(for: format(48_000))
        XCTAssertGreaterThanOrEqual(Double(count) * 1024 / 48_000, FlowPreRoll.windowSeconds)
    }

    func testWindowScalesWithSampleRate() {
        let low = FlowPreRoll.bufferCount(for: format(16_000))
        let high = FlowPreRoll.bufferCount(for: format(48_000))
        XCTAssertGreaterThan(high, low, "a faster rate needs more buffers for the same window")
    }

    /// Over-keeping is harmless; under-keeping loses the word. Core Audio is
    /// free to hand back a different buffer size than requested, so the count
    /// must carry slack.
    func testCountCarriesSlackAndHasAFloor() {
        XCTAssertGreaterThanOrEqual(FlowPreRoll.bufferCount(for: format(8_000)), 4)
        let exact = (48_000.0 * FlowPreRoll.windowSeconds) / 1024.0
        XCTAssertGreaterThan(FlowPreRoll.bufferCount(for: format(48_000)), Int(exact))
    }

    // MARK: - Deep copy

    /// The tap reuses its buffer. Anything held past the callback that has not
    /// copied its samples is handed audio that mutates underneath it — which
    /// shows up as garbled or empty pre-roll, not as a crash.
    func testDeepCopyIsIndependentOfTheSource() throws {
        let fmt = format(48_000)
        let source = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 512))
        source.frameLength = 512
        let channel = try XCTUnwrap(source.floatChannelData)
        for i in 0..<512 { channel[0][i] = 0.5 }

        let copy = try XCTUnwrap(source.deepCopy())
        // Mutate the source the way the tap would on its next callback.
        for i in 0..<512 { channel[0][i] = -1.0 }

        let copied = try XCTUnwrap(copy.floatChannelData)
        XCTAssertEqual(copied[0][0], 0.5, accuracy: 0.0001, "copy must not alias the tap's buffer")
        XCTAssertEqual(copy.frameLength, 512)
    }

    func testDeepCopyPreservesFormat() throws {
        let fmt = format(44_100, channels: 2)
        let source = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 256))
        source.frameLength = 256
        let copy = try XCTUnwrap(source.deepCopy())
        XCTAssertEqual(copy.format.sampleRate, 44_100)
        XCTAssertEqual(copy.format.channelCount, 2)
    }

    func testEmptyBufferCopiesToNothing() throws {
        let fmt = format(48_000)
        let source = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 256))
        source.frameLength = 0
        XCTAssertNil(source.deepCopy(), "a zero-length buffer carries no audio to keep")
    }

    // MARK: - Default

    /// The mic stays closed unless the user asks for it.
    @MainActor
    func testPreRollIsOffByDefault() {
        XCTAssertFalse(FlowConfig().preRoll)
    }
}
