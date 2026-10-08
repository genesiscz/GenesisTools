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
    }

    func play(profile: ClickySwitch, release: Bool, preferences: ClickyPreferences, pan: Float) throws {
        guard preferences.volume > 0 else { return }
        idleStop?.cancel()
        if !engine.isRunning {
            try PerfLog.span("clicky.audio.start") { try engine.start() }
        }
        let voice = voices[cursor]
        cursor = (cursor + 1) % voices.count
        voice.0.volume = Float(preferences.volume)
        voice.0.pan = preferences.spatialAudio ? pan : 0
        voice.1.rate = preferences.randomizedPitch ? Float.random(in: 0.95...1.05) : 1
        let variant = preferences.randomizedPitch ? Int.random(in: 0..<3) : 1
        if let buffer = buffers[key(profile, release, variant)] {
            voice.0.scheduleBuffer(buffer, at: nil, options: .interrupts)
            if !voice.0.isPlaying {
                voice.0.play()
            }
        }
        let stop = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.stop() }
        }
        idleStop = stop
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: stop)
    }

    func stop() {
        idleStop?.cancel()
        idleStop = nil
        for voice in voices { voice.0.stop() }
        engine.stop()
    }

    private func key(_ profile: ClickySwitch, _ release: Bool, _ variant: Int) -> String {
        "\(profile.rawValue)-\(release)-\(variant)"
    }
}
