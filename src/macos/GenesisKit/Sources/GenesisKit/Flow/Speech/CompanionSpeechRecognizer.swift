// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Companion/CompanionSpeechRecognizer.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
//
//  CompanionSpeechRecognizer.swift
//  Genesis
//
//  One-brain refactor (2026-07-20 decision doc): push-to-talk STT, fully
//  on-device via SFSpeechRecognizer. The companion no longer opens an xAI
//  realtime session — eve (via relay-prompt) is the only brain, and this
//  class is the microphone half of the local transport. Mic is hot ONLY
//  between start() and finish()/cancel() — the F6 hold window, plus an
//  optional short tail after release so the last word is not cut.
//
//  ONE HOLD ≠ ONE UTTERANCE (live bug 2026-07-24, `stt finish chars=0
//  finalized=true held=13095ms buffers=129 results=22`): SFSpeech finalizes an
//  utterance after ~a second of silence and then either ENDS the task or
//  restarts reporting from scratch, so a pause mid-hold used to wipe every word
//  spoken before it. This class therefore keeps a per-hold accumulator:
//  `committed` (utterances SFSpeech already closed) + `segment` (the live one),
//  and transparently spins up a fresh recognition task whenever the current one
//  finalizes while the key is still down. Restarting also sidesteps SFSpeech's
//  ~1-minute per-task ceiling, so long holds keep transcribing.
//
//  SHORT HOLDS (live 2026-09-10 `held=360ms buffers=0`, 2026-09-25
//  `buffers=7 … No speech detected`): the audio now comes from a
//  `CompanionAudioSource` (a fresh engine per hold, see CompanionAudioInput),
//  every buffer is also kept in a bounded `CompanionHoldCapture`, and when the
//  streaming result is empty although audio arrived, the captured clip is
//  recognized once more as a whole before the hold counts as silent.
//

import AVFoundation
import Foundation
import Speech

/// Thread-safe holder for the recognition request. The mic tap runs off-main
/// and must keep feeding audio across a mid-hold request swap (segment
/// restart) without racing the MainActor writer.
final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    /// While gated, live buffers wait in `held`: the pre-roll must reach the request first.
    private var gated = false
    private var held: [AVAudioPCMBuffer] = []

    func set(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        self.request = request
        if request == nil {
            gated = false
            held.removeAll()
        }
        lock.unlock()
    }

    /// Holds live audio until `open(after:)`.
    func gate() {
        lock.lock()
        gated = true
        held.removeAll()
        lock.unlock()
    }

    /// Feeds `first` (the pre-roll), then the live audio held meanwhile, and lets later audio straight through.
    /// Done under the lock, so a live buffer arriving now cannot overtake the ones before it.
    func open(after first: [AVAudioPCMBuffer]) {
        lock.lock()
        defer { lock.unlock() }
        for buffer in first { request?.append(buffer) }
        for buffer in held { request?.append(buffer) }
        held.removeAll()
        gated = false
    }

    /// The live audio waiting for `open(after:)`.
    var heldBuffers: [AVAudioPCMBuffer] {
        lock.lock()
        defer { lock.unlock() }
        return held
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        if gated {
            // Copy: the tap reuses its buffer, so a held reference would carry the audio of a later callback.
            if let copy = buffer.deepCopy() { held.append(copy) }
            lock.unlock()
            return
        }
        let request = self.request
        lock.unlock()
        request?.append(buffer)
    }
}

/// Per-hold transcript accumulator, shared by both STT transports.
///
/// One F6 hold can contain SEVERAL utterances (speak, pause, speak again) and a
/// later one must never erase an earlier one. `committed` holds the utterances
/// the recognizer already closed, `segment` the live one being revised in
/// place; `text` is always the whole hold. A value type on purpose: the
/// interesting rules are unit-testable without a microphone.
public struct CompanionTranscriptAccumulator {
    public init() {}

    public private(set) var committed = ""
    public private(set) var segment = ""

    /// Everything heard during this hold.
    public var text: String {
        if committed.isEmpty { return segment }
        if segment.isEmpty { return committed }
        return committed + " " + segment
    }

    /// Feed a fresh transcription of the live utterance.
    ///
    /// Within one recognition task the recognizer's `formattedString` is
    /// AUTHORITATIVE for that whole utterance — it freely rewrites the head as
    /// it gains context ("Produce on See on my screen" -> "What do you see on
    /// my screen"). So a revision always REPLACES the segment; only an explicit
    /// task boundary (`commit()`) starts a new one. An earlier version tried to
    /// detect "the head changed, so this must be a new utterance" and committed
    /// mid-revision, which duplicated every rewritten phrase (live:
    /// `transcript="Produce on See on my screen what do you see on my screen
    /// Produce see on my screen what do you see on my screen"`).
    public mutating func update(_ next: String) {
        // An empty revision NEVER wipes the hold — SFSpeech emits one on the
        // final callback of a silence-closed utterance (live: 22 results,
        // `chars=0`).
        guard !next.isEmpty else { return }
        segment = next
    }

    /// Fold the live utterance into the accumulated text.
    public mutating func commit() {
        let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        segment = ""
        guard !trimmed.isEmpty else { return }
        committed = committed.isEmpty ? trimmed : committed + " " + trimmed
    }

    public mutating func reset() {
        committed = ""
        segment = ""
    }
}

@MainActor
public final class CompanionSpeechRecognizer: ObservableObject {

    /// Optional source of audio captured before `start()` was called.
    ///
    /// Set by Flow's dictation path (see `FlowPreRoll`); the companion leaves
    /// it nil, so F6 behaviour is unchanged. Buffers whose format does not
    /// match the live tap are dropped rather than fed — a mismatched format is
    /// silently discarded by the recogniser and would cost the whole turn.
    public var preRollProvider: (() -> [AVAudioPCMBuffer])?

    /// Where holds get their audio: the mic by default, a WAV file in tests.
    public var audioSource: CompanionAudioSource

    /// Record from the built-in mic when the system default input is a
    /// Bluetooth headset (the companion sets this from its settings).
    public var avoidBluetoothMic: Bool {
        get { (audioSource as? CompanionMicSource)?.avoidBluetooth ?? false }
        set { (audioSource as? CompanionMicSource)?.avoidBluetooth = newValue }
    }

    /// Recognize the captured clip once more when the streaming result is
    /// empty although audio arrived.
    public var retryOnEmpty = true

    /// false = capture-only holds: the audio path, tail and hold report run,
    /// no recognition task starts. Tests use it where the runner has no Speech
    /// Recognition grant (starting a task there aborts the process).
    public var recognizes = true
    var speechAuthorizationGranted: () -> Bool = { CompanionSpeechRecognizer.speechAuthorized() }

    /// Live partial transcript while the user is speaking (HUD "You" row).
    /// Always the WHOLE hold so far — committed utterances plus the live one.
    @Published public private(set) var partialText = ""
    /// 0…1 mic level for the HUD meter.
    @Published public private(set) var micLevel: Double = 0

    /// What the last finished hold captured and returned.
    public struct HoldReport: Equatable {
        public let text: String
        public let stats: CompanionHoldCapture.Stats
        public let heldMs: Int
        public let tailMs: Int
        public let retried: Bool
    }

    public private(set) var lastHold: HoldReport?

    /// Drops the finished hold's text; a hold in progress keeps its own.
    func clearTranscript() {
        guard !isActive else { return }
        acc.reset()
        if !partialText.isEmpty { partialText = "" }
    }

    func applyRemote(partialText: String, micLevel: Double) {
        guard !isActive else { return }
        if self.partialText != partialText { self.partialText = partialText }
        if self.micLevel != micLevel { self.micLevel = micLevel }
    }

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let box = RequestBox()
    private let capture = CompanionHoldCapture()

    /// Committed utterances + the live one, for THIS hold.
    private var acc = CompanionTranscriptAccumulator()
    /// True between start() and the end of finish()'s tail — gates segment
    /// restarts.
    private var isActive = false
    private var finalized = false
    private var onDevice = true
    /// Bumps per recognition task; stale callbacks are ignored.
    private var generation = 0
    /// Bumps on every cancel (and so on every start): a finish() that was
    /// waiting on a tail or a final result checks it and gives up the hold
    /// instead of tearing down the next one.
    private var holdId = 0
    /// finish() waiting for the final result; woken by it, by a cancel, by its deadline or by task cancellation.
    private var finalWaiter: CheckedContinuation<Void, Never>?
    /// Which waitForFinal call `finalWaiter` belongs to: its deadline and cancellation wake only that one.
    private var finalWaiterToken = 0
    private var finalWaitCount = 0
    var currentHold: Int { holdId }

    /// A mic level belongs on the ring only while the hold that measured it is live.
    public func acceptsMicLevel(fromHold hold: Int) -> Bool {
        isActive && hold == holdId
    }

    private var restarts = 0
    private var resultCount = 0
    private var startedAt = Date()

    /// Sanity ceiling on mid-hold restarts (a recognizer erroring in a tight
    /// loop must not spin forever).
    private static let maxRestarts = 40

    public init(audioSource: CompanionAudioSource? = nil) {
        self.audioSource = audioSource ?? CompanionMicSource()
    }

    // MARK: - Permissions

    public nonisolated static func speechAuthorized() -> Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    public nonisolated static func speechAuthorizationDetermined() -> Bool {
        SFSpeechRecognizer.authorizationStatus() != .notDetermined
    }

    public nonisolated static func requestSpeechAuthorization() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }

    public nonisolated static func micAuthorized() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    public nonisolated static func requestMicAuthorization() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    /// `Locale.current.identifier` on macOS carries user preference subtags
    /// (observed live: `en_US@rg=czzzzz`), which SFSpeech resolves erratically.
    /// Keep only the language_REGION core.
    public nonisolated static func normalizedLocale(_ locale: Locale) -> Locale {
        let core = locale.identifier.split(separator: "@").first.map(String.init) ?? locale.identifier
        return core.isEmpty ? locale : Locale(identifier: core)
    }

    // MARK: - Push-to-talk lifecycle

    /// Start capturing + recognizing. Throws when the recognizer is
    /// unavailable (bad locale, no auth) or the audio source fails.
    /// `forceServer` disables on-device recognition (fallback when on-device
    /// silently yields nothing — a known SFSpeech flakiness on macOS).
    public func start(locale: Locale = .current, forceServer: Bool = false) throws {
        cancel() // never stack two sessions
        guard !recognizes || speechAuthorizationGranted() else {
            throw CompanionSpeechError.speechNotAuthorized
        }

        let resolved = Self.normalizedLocale(locale)
        guard let recognizer = SFSpeechRecognizer(locale: resolved) ?? SFSpeechRecognizer() else {
            throw CompanionSpeechError.recognizerUnavailable
        }
        guard recognizer.isAvailable else {
            throw CompanionSpeechError.recognizerUnavailable
        }
        // Server recognition only when the user turned it on: Settings promises that "Off keeps transcription on
        // this machine", so a language with no on-device model is refused instead of sent to Apple's server.
        guard forceServer || recognizer.supportsOnDeviceRecognition else {
            throw CompanionSpeechError.onDeviceUnavailable(recognizer.locale.identifier)
        }
        self.recognizer = recognizer
        onDevice = !forceServer

        partialText = ""
        acc.reset()
        finalized = false
        isActive = true
        restarts = 0
        resultCount = 0
        startedAt = Date()
        lastHold = nil
        capture.begin()

        // The source feeds the BOX, not `self.request`, so a mid-hold segment
        // restart swaps the request underneath it without dropping audio. Every
        // buffer is also kept in `capture` for the empty-result retry.
        let box = self.box
        let capture = self.capture
        let sourceStart = ProcessInfo.processInfo.systemUptime
        let hold = holdId
        let format: AVAudioFormat
        // Live audio waits until the pre-roll below is in the request, so the recognizer hears it in order.
        box.gate()
        do {
            format = try audioSource.start { [weak self] buffer in
                box.append(buffer)
                let level = capture.record(buffer)
                Task { @MainActor [weak self] in
                    // A level queued before finish() or cancel() must not undo their reset to 0.
                    guard let self, self.acceptsMicLevel(fromHold: hold), self.micLevel != level else { return }
                    self.micLevel = level
                }
            }
        } catch {
            isActive = false
            teardown()
            throw error
        }
        let sourceStartMs = Int(((ProcessInfo.processInfo.systemUptime - sourceStart) * 1000).rounded())

        startRecognitionTask()

        // Splice in audio captured BEFORE this call, if a provider is set.
        // People start speaking as they press, not after, so an engine that
        // only begins at key-down has already missed the onset — this is the
        // "missing first word" every dictation tool in the category has.
        // The live audio captured since the source started is held by the box
        // and follows the pre-roll, so the ordering stays chronological.
        var preRollBuffers: [AVAudioPCMBuffer] = []
        if let preRoll = preRollProvider {
            let buffers = preRoll()
            preRollBuffers = buffers.filter { $0.format == format }
            if !buffers.isEmpty {
                FlowFocusLog.speech.info("stt pre-roll spliced buffers=\(buffers.count)")
            }
        }
        // The retry clip is built from the same audio, in the same order, as the streaming request.
        capture.prepend(preRollBuffers)
        box.open(after: preRollBuffers)

        FlowFocusLog.speech.info("stt start locale=\(recognizer.locale.identifier) onDevice=\(self.onDevice) device=\(self.audioSource.deviceLabel) inputRate=\(Int(format.sampleRate)) ch=\(format.channelCount) sourceStartMs=\(sourceStartMs)")
    }

    /// End the utterance (F6 released) and wait briefly for the final
    /// transcription. Returns the best transcript — possibly empty (silent
    /// hold), never throws.
    ///
    /// `tailMs` keeps capturing that long after the release: a key comes up
    /// while the last syllable is still in the air, and cutting the audio at
    /// the release drops it.
    public func finish(timeoutSeconds: Double = 3.0, tailMs: Int = 0) async -> String {
        guard isActive || request != nil else { return "" } // never started
        let hold = holdId
        let heldMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        if tailMs > 0, isActive {
            try? await Task.sleep(nanoseconds: UInt64(tailMs) * 1_000_000)
            // Esc, a tap or a new hold during the tail owns the state now.
            guard hold == holdId, isActive else { return "" }
        }
        // Clear FIRST: a final result arriving while we drain must not spawn
        // another segment.
        isActive = false
        audioSource.stop()
        micLevel = 0
        request?.endAudio()
        await waitForFinal(timeoutSeconds: timeoutSeconds, hold: hold)
        guard hold == holdId else { return "" }
        acc.commit()
        var text = acc.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let stats = capture.snapshot()

        var retried = false
        if text.isEmpty, stats.buffers > 0, retryOnEmpty, recognizes, let recognizer {
            retried = true
            FlowFocusLog.speech.info("stt empty with buffers=\(stats.buffers) audio=\(stats.audioMs)ms, recognizing the captured clip once more")
            let clip = CompanionHoldCapture.joined(capture.retainedBuffers(), padMs: 400)
            if let clip {
                text = await Self.transcribe(
                    buffer: clip, recognizer: recognizer, onDevice: onDevice, timeoutSeconds: 8)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            guard hold == holdId else { return "" }
            FlowFocusLog.speech.info("stt retry chars=\(text.count)")
        }

        let peak = String(format: "%.3f", stats.peakLevel)
        FlowFocusLog.speech.info("stt finish chars=\(text.count) finalized=\(self.finalized) held=\(heldMs)ms tail=\(tailMs)ms buffers=\(stats.buffers) audio=\(stats.audioMs)ms firstBuffer=\(stats.firstBufferMs.map { "\($0)ms" } ?? "none") peak=\(peak) results=\(self.resultCount) segments=\(self.restarts + 1) retried=\(retried) device=\(self.audioSource.deviceLabel)")
        if text.isEmpty && stats.buffers == 0 {
            FlowFocusLog.speech.error("stt got ZERO audio buffers — mic tap delivered nothing (check Microphone permission + input device)")
        } else if text.isEmpty && stats.peakLevel < 0.02 {
            FlowFocusLog.speech.warning("stt audio was silent (peak=\(peak)) — the input device delivered near-zero samples")
        }
        lastHold = HoldReport(text: text, stats: stats, heldMs: heldMs, tailMs: tailMs, retried: retried)
        teardown()
        return text
    }

    /// Suspends until the recognizer reports its final result (or an error), the hold is cancelled, the deadline
    /// passes, or the calling task is cancelled. Event-driven: one deadline timer, no polling.
    func waitForFinal(timeoutSeconds: Double, hold: Int) async {
        guard recognizes, !finalized, hold == holdId else { return }
        finalWaitCount &+= 1
        let token = finalWaitCount
        let deadline = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, timeoutSeconds) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.wakeFinalWaiter(token: token)
        }
        defer { deadline.cancel() }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                guard !finalized, hold == holdId, !Task.isCancelled else {
                    continuation.resume()
                    return
                }
                wakeFinalWaiter()
                finalWaiter = continuation
                finalWaiterToken = token
            }
        } onCancel: {
            // Runs later, on the main actor: by then a cancel() and a new hold may have installed another
            // waiter, which this must not end.
            Task { @MainActor [weak self] in self?.wakeFinalWaiter(token: token) }
        }
    }

    /// The audio finish() would retry with, oldest first.
    var retainedForRetry: [AVAudioPCMBuffer] { capture.retainedBuffers() }

    func markFinalized() {
        finalized = true
        wakeFinalWaiter()
    }

    /// `token`: wake only if the waiter is still that wait's own; nil wakes whichever is waiting.
    private func wakeFinalWaiter(token: Int? = nil) {
        if let token, token != finalWaiterToken { return }
        let waiter = finalWaiter
        finalWaiter = nil
        waiter?.resume()
    }

    /// Abort without a transcript (Esc / tap-cancel).
    public func cancel() {
        holdId += 1
        wakeFinalWaiter()
        isActive = false
        audioSource.stop()
        teardown()
        acc.reset()
        partialText = ""
        micLevel = 0
    }

    // MARK: - Recognition tasks (one per utterance segment)

    private func startRecognitionTask() {
        guard recognizes, let recognizer else { return }
        guard speechAuthorizationGranted() else {
            FlowFocusLog.speech.error("Speech Recognition permission is unavailable; capture stopped")
            cancel()
            return
        }
        generation += 1
        let gen = generation
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = onDevice
        self.request = request
        box.set(request)
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                self?.handle(result: result, error: error, generation: gen)
            }
        }
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?, generation gen: Int) {
        guard gen == generation else { return } // stale segment

        if let result {
            resultCount += 1
            acc.update(result.bestTranscription.formattedString)
            partialText = acc.text
            if result.isFinal {
                acc.commit()
                partialText = acc.text
                if isActive {
                    restartSegment(reason: "utterance final")
                } else {
                    markFinalized()
                }
                return
            }
        }

        if let error {
            // endAudio() commonly surfaces a benign "no speech" error —
            // finalize with whatever partial we have. Log it so a real
            // recognizer failure isn't invisible.
            if resultCount == 0 {
                FlowFocusLog.speech.warning("stt recognition error (0 results): \(error.localizedDescription)")
            }
            acc.commit()
            partialText = acc.text
            if isActive {
                restartSegment(reason: "error \(error.localizedDescription)")
            } else {
                markFinalized()
            }
        }
    }

    /// The key is still down but this recognition task is done — open a fresh
    /// one so the rest of the hold keeps transcribing. The audio source keeps
    /// running throughout (it feeds the box, not a specific request).
    private func restartSegment(reason: String) {
        task?.cancel()
        task = nil
        request = nil
        box.set(nil)
        guard isActive, restarts < Self.maxRestarts, recognizer != nil else {
            markFinalized()
            if isActive {
                FlowFocusLog.speech.warning("stt restart budget exhausted (\(self.restarts)) — mic stays open but silent")
            }
            return
        }
        restarts += 1
        FlowFocusLog.speech.info("stt segment restart #\(self.restarts) (\(reason)) committed=\(self.acc.text.count) chars")
        startRecognitionTask()
    }

    // MARK: - Whole-clip recognition (retry, test harness, offline files)

    /// Recognize one finished clip. Shared by the empty-hold retry and
    /// `transcribeFile`, so the harness exercises the retry's exact wiring.
    public nonisolated static func transcribe(
        buffer: AVAudioPCMBuffer,
        recognizer: SFSpeechRecognizer,
        onDevice: Bool,
        timeoutSeconds: Double
    ) async -> String {
        guard speechAuthorized() else {
            FlowFocusLog.speech.error("File transcription requires Speech Recognition permission")
            return ""
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = onDevice
        if buffer.frameLength > 0 { request.append(buffer) }
        request.endAudio()

        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            let once = ResumeOnce()
            let task = recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    if once.claim() { cont.resume(returning: result.bestTranscription.formattedString) }
                } else if error != nil {
                    if once.claim() { cont.resume(returning: result?.bestTranscription.formattedString ?? "") }
                }
            }
            // The callback always fires, but never hang a hold or a test.
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                if once.claim() {
                    task.cancel()
                    cont.resume(returning: "")
                }
            }
        }
    }

    /// Transcribe an audio file with the same recognizer the live path uses.
    /// Feeds the file through an `SFSpeechAudioBufferRecognitionRequest` (not
    /// the URL request) so this exercises the exact append/task wiring the mic
    /// path relies on — only the source of the buffers differs. Static: no
    /// engine, safe to call from tests without the mic.
    public nonisolated static func transcribeFile(_ url: URL, locale: Locale = .current, forceServer: Bool = false) async -> String {
        guard let recognizer = SFSpeechRecognizer(locale: normalizedLocale(locale)) ?? SFSpeechRecognizer(),
              recognizer.isAvailable
        else { return "" }
        // The same promise as `start`: no server recognition unless it was asked for.
        guard forceServer || recognizer.supportsOnDeviceRecognition else { return "" }
        let file: AVAudioFile
        do { file = try AVAudioFile(forReading: url) } catch { return "" }
        let frameCount = AVAudioFrameCount(file.length)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frameCount)
        else { return "" }
        do { try file.read(into: buffer) } catch { return "" }
        return await transcribe(
            buffer: buffer, recognizer: recognizer,
            onDevice: !forceServer,
            timeoutSeconds: 20)
    }

    // MARK: - Internals

    private func teardown() {
        // The retained clip exists for finish()'s empty-result retry only; a cancelled or finished hold drops it.
        capture.reset()
        task?.cancel()
        task = nil
        request = nil
        box.set(nil)
        recognizer = nil
        generation += 1 // orphan any in-flight callback
    }
}

public enum CompanionSpeechError: LocalizedError {
    case recognizerUnavailable
    case speechNotAuthorized
    case microphoneNotAuthorized
    case onDeviceUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "speech recognizer unavailable — check Settings → Privacy → Speech Recognition"
        case .speechNotAuthorized:
            return "Allow Speech Recognition in Dictation settings before dictating."
        case .microphoneNotAuthorized:
            return "Allow Microphone access in Dictation settings before recording."
        case .onDeviceUnavailable(let locale):
            return "\(locale) has no on-device recognition on this Mac. Turn on server recognition in Dictation settings to send its audio to Apple."
        }
    }
}
