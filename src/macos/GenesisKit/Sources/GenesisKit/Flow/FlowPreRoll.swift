// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowPreRoll.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AVFoundation
import Foundation

/// Keeps the last few hundred milliseconds of microphone audio so a dictation
/// turn can include the words spoken *before* the hotkey landed.
///
/// ## Why this exists
///
/// Every dictation tool in this category loses the first word or two, and it is
/// the single most repeated complaint about all of them — BridgeVoice
/// documents that it "discards a small amount of audio at the very start of
/// every recording", and Wispr Flow lists "missing first words" as an official
/// known issue. The cause is structural: people start speaking as they press,
/// not after, and an engine that only starts capturing on key-down has already
/// missed the onset.
///
/// A rolling buffer fixes it outright rather than mitigating it.
///
/// ## The cost, stated plainly
///
/// This holds the microphone open continuously. macOS shows the orange
/// indicator the whole time it runs, and nothing is written to disk or sent
/// anywhere — the ring is a fixed number of in-memory buffers that overwrite
/// themselves — but "the mic is on when I have not asked for it" is a real
/// tradeoff, not a free win. It is therefore **opt-in** (`FlowConfig.preRoll`),
/// default off, and `stop()` releases the device entirely.
///
/// ## Why the engines are sequential, not concurrent
///
/// The recogniser installs its own tap on the same input node. Running both
/// engines at once is a fight over one device with no upside, so the handover
/// is: snapshot the ring → stop this engine → let the recogniser start → feed
/// it the snapshot. The gap costs nothing because the audio for that gap is
/// already in hand.
@MainActor
public final class FlowPreRoll {

    /// How much history to keep. 600 ms comfortably covers "press-as-you-speak"
    /// without holding enough audio to be a recording.
    public nonisolated static let windowSeconds: Double = 0.6

    private var engine: AVAudioEngine?
    private let ring = Ring()

    public private(set) var isRunning = false
    var authorizationGranted: () -> Bool = {
        CompanionSpeechRecognizer.micAuthorized() && CompanionSpeechRecognizer.speechAuthorized()
    }

    /// Format of the buffers currently in the ring, for the caller to check
    /// against the recogniser's expectations.
    public private(set) var format: AVAudioFormat?

    // MARK: - Lifecycle

    /// Begin holding a rolling window. Safe to call repeatedly.
    public func start() {
        guard authorizationGranted() else {
            stop()
            FlowFocusLog.flow.info("pre-roll waits for explicit microphone and Speech Recognition permission")
            return
        }
        guard !isRunning else { return }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            FlowFocusLog.flow.error("pre-roll: bad input format rate=\(format.sampleRate) ch=\(format.channelCount)")
            return
        }

        let capacity = Self.bufferCount(for: format)
        ring.configure(capacity: capacity)

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [ring] buffer, _ in
            // Copy: the tap reuses its buffer, so retaining it hands us audio
            // that mutates underneath the ring.
            guard let copy = buffer.deepCopy() else { return }
            ring.append(copy)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            FlowFocusLog.flow.error("pre-roll: engine start failed: \(error.localizedDescription)")
            return
        }

        self.engine = engine
        self.format = format
        isRunning = true
        FlowFocusLog.flow.info("pre-roll running window=\(Self.windowSeconds)s buffers=\(capacity)")
    }

    /// Release the microphone. The ring is kept so a turn starting in the same
    /// breath still gets its history.
    public func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        isRunning = false
    }

    /// Hand over the buffered history and clear it.
    ///
    /// Draining is deliberate: replaying the same audio into a second turn
    /// would duplicate whatever was said at the boundary.
    public func drain() -> [AVAudioPCMBuffer] {
        ring.drain()
    }

    /// Number of tap buffers needed to cover the window.
    ///
    /// The tap is requested at 1024 frames, but Core Audio is free to hand back
    /// a different size, so this is a ceiling with slack rather than an exact
    /// count — over-keeping a little is harmless, under-keeping loses the word.
    public nonisolated static func bufferCount(for format: AVAudioFormat) -> Int {
        let framesPerBuffer = 1024.0
        let needed = (format.sampleRate * windowSeconds) / framesPerBuffer
        return max(4, Int(needed.rounded(.up)) + 2)
    }

    // MARK: - Ring

    /// Fixed-size circular buffer, safe to write from the audio thread.
    ///
    /// A plain array with `removeFirst()` would allocate on every tap callback,
    /// which is exactly what must not happen on the render thread.
    private final class Ring: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [AVAudioPCMBuffer?] = []
        private var next = 0
        private var filled = 0

        func configure(capacity: Int) {
            lock.lock()
            storage = Array(repeating: nil, count: max(1, capacity))
            next = 0
            filled = 0
            lock.unlock()
        }

        func append(_ buffer: AVAudioPCMBuffer) {
            lock.lock()
            guard !storage.isEmpty else { lock.unlock(); return }
            storage[next] = buffer
            next = (next + 1) % storage.count
            filled = min(filled + 1, storage.count)
            lock.unlock()
        }

        /// Oldest-first, then reset.
        func drain() -> [AVAudioPCMBuffer] {
            lock.lock()
            defer {
                storage = Array(repeating: nil, count: storage.count)
                next = 0
                filled = 0
                lock.unlock()
            }
            guard filled > 0 else { return [] }
            let start = (next - filled + storage.count) % storage.count
            return (0..<filled).compactMap { storage[(start + $0) % storage.count] }
        }
    }
}

extension AVAudioPCMBuffer {
    /// Independent copy of the frames currently in this buffer.
    ///
    /// The tap hands back a buffer it will overwrite, so anything held past the
    /// callback must own its samples.
    public func deepCopy() -> AVAudioPCMBuffer? {
        guard
            let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength),
            frameLength > 0
        else { return nil }
        copy.frameLength = frameLength

        let channels = Int(format.channelCount)
        if let source = floatChannelData, let destination = copy.floatChannelData {
            for channel in 0..<channels {
                destination[channel].update(from: source[channel], count: Int(frameLength))
            }
            return copy
        }
        if let source = int16ChannelData, let destination = copy.int16ChannelData {
            for channel in 0..<channels {
                destination[channel].update(from: source[channel], count: Int(frameLength))
            }
            return copy
        }
        return nil
    }
}
