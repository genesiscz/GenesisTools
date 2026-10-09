// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowPreRollTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AVFoundation
import Speech
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

    @MainActor
    func testTurningPreRollOffDiscardsTheAudioItHeld() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-preroll-discard-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = false
        config.preRoll = true
        store.saveConfig(config)
        let session = FlowSession(store: store)
        session.preRollEffect = { _ in }
        session.hotkeyBindingEffect = {}
        session.start()
        defer { session.stop() }
        session.preRoll.record(try filled(0.5))
        session.config.preRoll = false
        XCTAssertEqual(session.recognizer.preRollProvider?().count, 0,
                       "audio held before the setting went off must not reach a later turn")

        // Negative control: a turn's own handoff still carries what the ring held.
        session.config.preRoll = true
        session.preRoll.record(try filled(0.5))
        var handed = -1
        session.recognitionStartEffect = { [weak session] in
            handed = session?.recognizer.preRollProvider?().count ?? -1
        }
        session.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(handed, 1)
    }

    func testGatedLiveAudioIsCopiedBeforeItIsHeld() throws {
        let box = RequestBox()
        box.gate()
        let source = try filled(0.5)
        box.append(source)
        // The tap's next callback reuses the same buffer.
        let channel = try XCTUnwrap(source.floatChannelData)
        for i in 0..<Int(source.frameLength) { channel[0][i] = -1.0 }
        box.append(source)
        let held = box.heldBuffers
        XCTAssertEqual(held.count, 2)
        XCTAssertEqual(try XCTUnwrap(held.first?.floatChannelData)[0][0], 0.5, accuracy: 0.0001,
                       "the first held buffer keeps the audio of its own callback")
        XCTAssertEqual(try XCTUnwrap(held.last?.floatChannelData)[0][0], -1.0, accuracy: 0.0001)
    }

    private func filled(_ value: Float) throws -> AVAudioPCMBuffer {
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format(48_000), frameCapacity: 256))
        buffer.frameLength = 256
        let channel = try XCTUnwrap(buffer.floatChannelData)
        for i in 0..<256 { channel[0][i] = value }
        return buffer
    }

    @MainActor
    func testCapturePrimitivesDoNotOpenInputWithoutAnExistingGrant() throws {
        let source = PermissionGuardAudioSource()
        let recognizer = CompanionSpeechRecognizer(audioSource: source)
        recognizer.speechAuthorizationGranted = { false }
        XCTAssertThrowsError(try recognizer.start()) { error in
            XCTAssertTrue(error.localizedDescription.contains("Allow Speech Recognition"))
        }
        XCTAssertEqual(source.starts, 0)
        recognizer.recognizes = false
        XCTAssertThrowsError(try recognizer.start(locale: Locale(identifier: "en-US"))) { error in
            XCTAssertEqual((error as? CocoaError)?.code, .fileReadCorruptFile)
        }
        XCTAssertEqual(source.starts, 1, "capture-only file input remains usable without Speech permission")
        let mic = CompanionMicSource()
        mic.microphoneAuthorizationGranted = { false }
        XCTAssertThrowsError(try mic.start { _ in XCTFail("no microphone buffers are permitted") }) { error in
            XCTAssertTrue(error.localizedDescription.contains("Allow Microphone"))
        }
        let preRoll = FlowPreRoll()
        preRoll.authorizationGranted = { false }
        preRoll.start()
        XCTAssertFalse(preRoll.isRunning)
    }

    @MainActor
    func testPermissionRequestsAreExplicitCoalescedAndForwardedByPassiveHosts() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-explicit-permissions-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = false
        store.saveConfig(config)
        let session = FlowSession(store: store)
        session.hotkeyBindingEffect = {}
        var requests = 0
        let completed = expectation(description: "explicit permission request")
        session.permissionRequestEffect = {
            requests += 1
            completed.fulfill()
            return (false, false)
        }
        session.requestDictationPermissions()
        XCTAssertEqual(requests, 0, "an unelected or preview session cannot prompt")
        session.start()
        XCTAssertEqual(requests, 0, "launch never requests authorization")
        session.requestDictationPermissions()
        session.requestDictationPermissions()
        await fulfillment(of: [completed], timeout: 1)
        XCTAssertEqual(requests, 1)
        XCTAssertFalse(session.isRequestingPermissions)
        XCTAssertTrue(session.lastError?.contains("System Settings") == true)
        let passive = FlowSession(store: FlowStore(directory: root, writesEnabled: false))
        var forwarded: [String] = []
        passive.remoteCommand = { action, _ in forwarded.append(action) }
        passive.permissionRequestEffect = { XCTFail("the passive process must not prompt"); return (false, false) }
        passive.requestDictationPermissions()
        XCTAssertEqual(forwarded, ["flow.permissions"])
        session.stop()
    }

    @MainActor
    func testAccessibilityIsRequestedByTheOwnerAndClientsShowTheOwnersTrust() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-accessibility-owner-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = false
        store.saveConfig(config)
        let owner = FlowSession(store: store)
        owner.hotkeyBindingEffect = {}
        owner.preRollEffect = { _ in }
        var trusted = false
        var requests = 0
        owner.accessibilityTrustEffect = { trusted }
        owner.accessibilityRequestEffect = { requests += 1; trusted = true }
        owner.start()
        defer { owner.stop() }
        XCTAssertFalse(owner.accessibilityTrusted)

        let client = FlowSession(store: FlowStore(directory: root, writesEnabled: false))
        var forwarded: [String] = []
        client.remoteCommand = { action, _ in forwarded.append(action) }
        client.accessibilityRequestEffect = { XCTFail("the client process must not request Accessibility for itself") }
        client.accessibilityTrustEffect = { true }
        client.requestAccessibility()
        XCTAssertEqual(forwarded, ["flow.accessibility"])

        // The runtime runs the forwarded command on the owner, then publishes the owner's snapshot.
        owner.requestAccessibility()
        XCTAssertEqual(requests, 1)
        XCTAssertTrue(owner.accessibilityTrusted)
        client.applyRemote(owner.liveSnapshot)
        XCTAssertTrue(client.accessibilityTrusted, "the client shows the trust of the process that pastes")
        trusted = false
        owner.refreshAccessibilityTrust()
        client.applyRemote(owner.liveSnapshot)
        XCTAssertFalse(client.accessibilityTrusted, "a client's own grant never stands in for the owner's")
    }

    @MainActor
    func testFinishWakesOnTheFinalResultACancelOrItsDeadline() async throws {
        let finalised = CompanionSpeechRecognizer(audioSource: PermissionGuardAudioSource())
        let clock = ContinuousClock()
        var started = clock.now
        let waiting = Task { await finalised.waitForFinal(timeoutSeconds: 30, hold: finalised.currentHold) }
        for _ in 0..<100 { await Task.yield() }
        finalised.markFinalized()
        await waiting.value
        XCTAssertLessThan(clock.now - started, .seconds(5), "the final result wakes the wait")

        let cancelled = CompanionSpeechRecognizer(audioSource: PermissionGuardAudioSource())
        started = clock.now
        let held = Task { await cancelled.waitForFinal(timeoutSeconds: 30, hold: cancelled.currentHold) }
        for _ in 0..<100 { await Task.yield() }
        cancelled.cancel()
        await held.value
        XCTAssertLessThan(clock.now - started, .seconds(5), "a cancelled hold stops waiting")

        let silent = CompanionSpeechRecognizer(audioSource: PermissionGuardAudioSource())
        started = clock.now
        await silent.waitForFinal(timeoutSeconds: 0.2, hold: silent.currentHold)
        let waited = clock.now - started
        XCTAssertGreaterThanOrEqual(waited, .milliseconds(150), "with no result the deadline ends the wait")
        XCTAssertLessThan(waited, .seconds(5))

        let abandoned = CompanionSpeechRecognizer(audioSource: PermissionGuardAudioSource())
        started = clock.now
        let caller = Task { await abandoned.waitForFinal(timeoutSeconds: 30, hold: abandoned.currentHold) }
        for _ in 0..<100 { await Task.yield() }
        caller.cancel()
        await caller.value
        XCTAssertLessThan(clock.now - started, .seconds(5), "a cancelled caller stops waiting")
    }

    @MainActor
    func testACancelledWaitNeverEndsTheNextHoldsWait() async throws {
        let recognizer = CompanionSpeechRecognizer(audioSource: PermissionGuardAudioSource())
        let first = Task { await recognizer.waitForFinal(timeoutSeconds: 30, hold: recognizer.currentHold) }
        for _ in 0..<100 { await Task.yield() }
        // The caller gives up, the hold is cancelled, and the next hold starts waiting before the
        // cancellation's main-actor hop has run.
        first.cancel()
        recognizer.cancel()
        let clock = ContinuousClock()
        let started = clock.now
        await recognizer.waitForFinal(timeoutSeconds: 0.5, hold: recognizer.currentHold)
        XCTAssertGreaterThanOrEqual(clock.now - started, .milliseconds(400), "the second wait runs to its own deadline")
        await first.value
    }

    @MainActor
    func testClearingHistoryWhileAHoldFinalizesKeepsItsWords() async throws {
        let recognizer = CompanionSpeechRecognizer(audioSource: FixtureAudioSource(live: try filled(0.5)))
        recognizer.recognizes = false
        recognizer.retryOnEmpty = false
        do {
            try recognizer.start(locale: Locale(identifier: "en-US"), forceServer: true)
        } catch CompanionSpeechError.recognizerUnavailable {
            throw XCTSkip("No speech recognizer on this runner")
        }
        recognizer.recordRecognizedForTesting("words already heard")
        // Capture has stopped once finish() begins; it then waits for the final result.
        recognizer.recognizes = true
        let finishing = Task { await recognizer.finish(timeoutSeconds: 0.3) }
        for _ in 0..<100 { await Task.yield() }
        // What clearing history (or deleting the latest entry) does meanwhile.
        recognizer.clearTranscript()
        let text = await finishing.value
        XCTAssertEqual(text, "words already heard", "the finalizing hold keeps the words it already recognized")
    }

    @MainActor
    func testAnOlderFinishReturningDoesNotExposeTheNewerHoldsWords() async throws {
        let recognizer = CompanionSpeechRecognizer(audioSource: FixtureAudioSource(live: try filled(0.5)))
        recognizer.recognizes = false
        recognizer.retryOnEmpty = false
        do {
            try recognizer.start(locale: Locale(identifier: "en-US"), forceServer: true)
        } catch CompanionSpeechError.recognizerUnavailable {
            throw XCTSkip("No speech recognizer on this runner")
        }
        // The first hold is released with a tail, and cancelled while the tail runs.
        let older = Task { await recognizer.finish(timeoutSeconds: 0.1, tailMs: 200) }
        for _ in 0..<20 { await Task.yield() }
        recognizer.cancel()
        // The next hold starts and finishes while the older finish is still in its tail.
        try recognizer.start(locale: Locale(identifier: "en-US"), forceServer: true)
        recognizer.recordRecognizedForTesting("the newer hold's words")
        recognizer.recognizes = true
        let newer = Task { await recognizer.finish(timeoutSeconds: 0.8) }
        _ = await older.value
        // History is cleared after the older finish returned, while the newer one still waits.
        recognizer.clearTranscript()
        let text = await newer.value
        XCTAssertEqual(text, "the newer hold's words")
    }

    @MainActor
    func testPreRollLeadsTheRetryClipAndACancelledHoldKeepsNoAudio() throws {
        let live = try filled(0.9)
        let preRoll = try filled(0.1)
        let recognizer = CompanionSpeechRecognizer(audioSource: FixtureAudioSource(live: live))
        recognizer.recognizes = false
        recognizer.preRollProvider = { [preRoll] }
        do {
            try recognizer.start(locale: Locale(identifier: "en-US"), forceServer: true)
        } catch CompanionSpeechError.recognizerUnavailable {
            throw XCTSkip("No speech recognizer on this runner")
        }
        let clip = recognizer.retainedForRetry
        XCTAssertEqual(clip.count, 2)
        XCTAssertEqual(try XCTUnwrap(clip.first?.floatChannelData)[0][0], 0.1, accuracy: 0.0001,
                       "the retry starts with the pre-roll, as the streaming request did")
        XCTAssertEqual(try XCTUnwrap(clip.last?.floatChannelData)[0][0], 0.9, accuracy: 0.0001)
        recognizer.cancel()
        XCTAssertTrue(recognizer.retainedForRetry.isEmpty, "a cancelled hold keeps none of its audio")
    }

    func testWholeClipHelperReturnsWithoutStartingUnauthorizedRecognition() async throws {
        guard !CompanionSpeechRecognizer.speechAuthorized() else {
            throw XCTSkip("Negative control needs a runner without Speech authorization")
        }
        let recognizer = try XCTUnwrap(SFSpeechRecognizer(locale: Locale(identifier: "en-US")))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format(16_000), frameCapacity: 1))
        buffer.frameLength = 1
        let result = await CompanionSpeechRecognizer.transcribe(buffer: buffer, recognizer: recognizer,
                                                                onDevice: true, timeoutSeconds: 1)
        XCTAssertEqual(result, "")
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

/// Delivers one live buffer while it starts, the way a tap can fire before start() returns.
@MainActor
private final class FixtureAudioSource: CompanionAudioSource {
    let deviceLabel = "fixture-source"
    let live: AVAudioPCMBuffer
    init(live: AVAudioPCMBuffer) { self.live = live }
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat {
        onBuffer(live)
        return live.format
    }
    func stop() {}
}

@MainActor
private final class PermissionGuardAudioSource: CompanionAudioSource {
    let deviceLabel = "permission-test-fixture"
    var starts = 0
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat {
        starts += 1
        throw CocoaError(.fileReadCorruptFile)
    }
    func stop() {}
}
