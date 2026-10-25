import AVFoundation
import Foundation

/// Original procedural sounds. No recordings, downloaded samples, or third-party sound assets.
public enum ClickySynthesis {
    public static let sampleRate = 48_000.0

    public static func samples(profile: ClickySwitch, release: Bool, variant: Int) -> [Float] {
        let duration = release ? 0.065 : 0.11
        let frames = Int(sampleRate * duration)
        var state = UInt64(variant + 1) &* 7919 &+ UInt64(ClickySwitch.allCases.firstIndex(of: profile)! + 1) * 104729
        let frequency = profile.frequency * (release ? 1.65 : 1) * (1 + Double(variant - 1) * 0.024)
        let decay = profile.decay * (release ? 0.6 : 1)
        var lowNoise = 0.0
        return (0..<frames).map { frame in
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let noise = Double(state >> 33) / Double(UInt32.max >> 1) * 2 - 1
            lowNoise = lowNoise * 0.68 + noise * 0.32
            let t = Double(frame) / sampleRate
            let attack = min(1, t / 0.0007)
            let body = sin(2 * .pi * frequency * t) * exp(-t / decay)
            let overtone = sin(2 * .pi * frequency * 2.73 * t) * exp(-t / (decay * 0.45))
            let texture = (profile == .paper ? noise : lowNoise) * exp(-t / (decay * 0.5))
            let click = noise * exp(-t / 0.0017)
            let gain = release ? 0.40 : 0.65
            return Float(tanh((body * 0.47 + overtone * 0.18 + texture * 0.52 + click * 0.23) * attack) * gain)
        }
    }
}

@MainActor
final class ClickyAudio {
    private let engine: AVAudioEngine
    private let format = AVAudioFormat(standardFormatWithSampleRate: ClickySynthesis.sampleRate, channels: 1)!
    private var voices: [(AVAudioPlayerNode, AVAudioUnitVarispeed)] = []
    private var buffers: [String: AVAudioPCMBuffer] = [:]
    private var cursor = 0
    private var idleStop: DispatchWorkItem?
    /// The engine starts here, never on the main thread: the start ran inside the keyboard event tap and took 0.4 to
    /// 1 s after each 3 s pause on 2026-10-23 (HangWatch stalls in the settings face), and a tap that waits delays
    /// every key the user types.
    private let startQueue = DispatchQueue(label: "genesiskit.clicky.audio-start", qos: .userInteractive)
    private var starting = false
    /// Whether the engine runs, as this class started and stopped it. `AVAudioEngine.isRunning` takes the engine's
    /// lock, which a start on the start queue holds for its whole length: reading it there blocked the key tap again
    /// (HangWatch, 2026-10-23 21:14).
    private var running = false
    /// The click that arrived while the engine starts; it plays once the engine runs (a newer one replaces it).
    private var pendingClick: (() -> Void)?
    private var stopAfterStart = false
    private final class EngineBox: @unchecked Sendable {
        let engine: AVAudioEngine
        init(_ engine: AVAudioEngine) { self.engine = engine }
    }
    private struct PackBank {
        let reference: ClickyPackReference
        let manifestHash: String
        let playback: ClickyPackPlayback
        let buffers: [String: AVAudioPCMBuffer]
        let decodedFrames: Int
    }
    private var banks: [PackBank] = []
    private var activeReference: ClickyPackReference?
    private var liveSelection = ClickyPackSelectionState()
    private var previewSelection = ClickyPackSelectionState()
    var cachedPackCount: Int { banks.count }
    var cachedPackFrames: Int { banks.reduce(0) { $0 + $1.decodedFrames } }
    var selectedPackReference: ClickyPackReference? { activeReference }

    func install(reference: ClickyPackReference, pack: PreparedClickyPack) throws {
        if let index = banks.firstIndex(where: { $0.reference == reference && $0.manifestHash == pack.manifestHash }) {
            let bank = banks.remove(at: index)
            banks.append(bank)
        } else {
            var decoded: [String: AVAudioPCMBuffer] = [:]
            var unique: [String: AVAudioPCMBuffer] = [:]
            for (name, sample) in pack.samples {
                if let existing = unique[sample.sha256] {
                    decoded[name] = existing
                    continue
                }
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sample.frames.count)),
                    let channel = buffer.floatChannelData?[0]
                else { throw ClickyPackError.invalid("This sound pack could not allocate an audio buffer.") }
                buffer.frameLength = buffer.frameCapacity
                sample.frames.withUnsafeBufferPointer { pointer in
                    if let base = pointer.baseAddress { channel.update(from: base, count: pointer.count) }
                }
                decoded[name] = buffer
                unique[sample.sha256] = buffer
            }
            let bank = PackBank(reference: reference, manifestHash: pack.manifestHash, playback: pack.playback,
                                buffers: decoded, decodedFrames: unique.values.reduce(0) { $0 + Int($1.frameLength) })
            banks.removeAll { $0.reference == reference }
            banks.append(bank)
            if banks.count > 3 { banks.removeFirst(banks.count - 3) }
        }
        stop()
        activeReference = reference
    }

    func useBuiltIn() {
        stop()
        activeReference = nil
    }

    func clearHeldKeys() {
        liveSelection.clear()
        previewSelection.clear()
    }

    @discardableResult
    func playSelected(keyCode: UInt16, release: Bool, preview: Bool, preferences: ClickyPreferences, pan: Float) throws -> Bool {
        guard let reference = activeReference, let bank = banks.last(where: { $0.reference == reference }) else { return false }
        let choice: ClickySampleChoice?
        if preview {
            choice = previewSelection.next(playback: bank.playback, keyCode: keyCode, release: release)
        } else {
            choice = liveSelection.next(playback: bank.playback, keyCode: keyCode, release: release)
        }
        guard let choice, !release || preferences.releaseSounds, let buffer = bank.buffers[choice.filename] else { return true }
        let gain = bank.playback.gain * (release ? bank.playback.keyupGain : 1)
        try schedule(buffer, preferences: preferences, pan: pan, gain: gain, pitchVariation: bank.playback.pitchVariation)
        return true
    }

    init(engine: AVAudioEngine = AVAudioEngine()) {
        self.engine = engine
        for _ in 0..<12 {
            let player = AVAudioPlayerNode()
            let rate = AVAudioUnitVarispeed()
            engine.attach(player)
            engine.attach(rate)
            engine.connect(player, to: rate, format: format)
            engine.connect(rate, to: engine.mainMixerNode, format: format)
            voices.append((player, rate))
        }
        for profile in ClickySwitch.allCases {
            for release in [false, true] {
                for variant in 0..<3 {
                    let samples = ClickySynthesis.samples(profile: profile, release: release, variant: variant)
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
                    buffer.frameLength = buffer.frameCapacity
                    samples.withUnsafeBufferPointer { pointer in
                        buffer.floatChannelData![0].update(from: pointer.baseAddress!, count: samples.count)
                    }
                    buffers[key(profile, release, variant)] = buffer
                }
            }
        }
        engine.prepare()
        // A hardware change stops the engine without telling `running`; the next click must start it again.
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.starting else { return }
                self.running = false
            }
        }
    }

    func play(profile: ClickySwitch, release: Bool, preferences: ClickyPreferences, pan: Float) throws {
        let variant = preferences.randomizedPitch ? Int.random(in: 0..<3) : 1
        guard let buffer = buffers[key(profile, release, variant)] else { return }
        try schedule(buffer, preferences: preferences, pan: pan, gain: 1, pitchVariation: 0.05)
    }

    private func schedule(_ buffer: AVAudioPCMBuffer, preferences: ClickyPreferences, pan: Float, gain: Float, pitchVariation: Float) throws {
        guard preferences.volume > 0 else { return }
        idleStop?.cancel()
        // Offline rendering (tests) starts at once: no hardware to wake.
        if !running, !starting, engine.isInManualRenderingMode {
            try engine.start()
            running = true
        }
        guard running else {
            pendingClick = { [weak self] in
                try? self?.play(buffer, preferences: preferences, pan: pan, gain: gain, pitchVariation: pitchVariation)
            }
            startEngine()
            return
        }
        try play(buffer, preferences: preferences, pan: pan, gain: gain, pitchVariation: pitchVariation)
    }

    private func startEngine() {
        // A click after a stop request cancels the stop, also while a start is already in flight.
        stopAfterStart = false
        guard !starting else { return }
        starting = true
        let box = EngineBox(engine)
        startQueue.async {
            let begun = Date()
            var failure: Error?
            do { try box.engine.start() } catch { failure = error }
            let ms = Date().timeIntervalSince(begun) * 1000
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.starting = false
                    self.running = failure == nil
                    PerfLog.mark(String(format: "clicky.audio.start %.1fms off-main", ms)
                        + (failure.map { " failed: \($0.localizedDescription)" } ?? ""))
                    if self.stopAfterStart {
                        self.pendingClick = nil
                        self.stopVoices()
                        return
                    }
                    let click = self.pendingClick
                    self.pendingClick = nil
                    if failure == nil { click?() }
                }
            }
        }
    }

    private func play(_ buffer: AVAudioPCMBuffer, preferences: ClickyPreferences, pan: Float, gain: Float,
                      pitchVariation: Float) throws {
        let voice = voices[cursor]
        cursor = (cursor + 1) % voices.count
        voice.0.volume = min(1, max(0, Float(preferences.volume) * gain))
        voice.0.pan = preferences.spatialAudio ? pan : 0
        voice.1.rate = preferences.randomizedPitch ? Float.random(in: (1 - pitchVariation)...(1 + pitchVariation)) : 1
        voice.0.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !voice.0.isPlaying { voice.0.play() }
        let stop = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.stopVoices() }
        }
        idleStop = stop
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: stop)
    }

    func stop() {
        clearHeldKeys()
        stopVoices()
    }

    private func stopVoices() {
        idleStop?.cancel()
        idleStop = nil
        // A start in flight finishes first; the engine stops right after it.
        if starting {
            stopAfterStart = true
            return
        }
        running = false
        for voice in voices { voice.0.stop() }
        engine.stop()
    }

    private func key(_ profile: ClickySwitch, _ release: Bool, _ variant: Int) -> String {
        "\(profile.rawValue)-\(release)-\(variant)"
    }
}
