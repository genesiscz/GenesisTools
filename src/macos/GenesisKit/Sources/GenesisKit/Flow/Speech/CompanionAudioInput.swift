// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Companion/CompanionAudioInput.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
//
//  CompanionAudioInput.swift
//  Genesis
//
//  Where a push-to-talk hold gets its audio, and what the hold captured.
//
//  Live evidence (companion.log, 2026-09-10 and 2026-09-25): a 458 ms hold got
//  `buffers=0`, a 1119 ms hold got `buffers=7` at `inputRate=24000`. The 24 kHz
//  rate is not something the Voice Agent left behind: it is the AirPods mic.
//  `system_profiler SPAudioDataType` on this Mac lists the default input as a
//  Bluetooth headset at 24000 Hz. Opening a Bluetooth mic switches the headset
//  from A2DP to the hands-free profile, and the first buffers arrive only after
//  that switch, which takes longer than a short question. So the source below
//  can pick the built-in mic when the system default is Bluetooth
//  (`CompanionSettings.sttAvoidBluetoothMic`), and every hold logs the device,
//  its rate, when the first buffer came and how loud the audio was.
//

import AVFoundation
import CoreAudio
import Foundation

/// Where a hold's audio comes from. Live: the microphone. Tests: a WAV file.
@MainActor
protocol CompanionAudioSource: AnyObject {
    /// Device, transport and rate for the log line ("MacBook Pro Microphone
    /// (built-in) 48000Hz/1ch").
    var deviceLabel: String { get }
    /// Start delivering buffers and return their format. `onBuffer` runs on
    /// the audio thread.
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat
    func stop()
}

/// The microphone through a FRESH `AVAudioEngine` per hold.
///
/// Never reuse an engine or a cached format: the input device and its rate can
/// change between holds (a headset connects, another app asks for 24 kHz), and
/// a buffer in a stale format is dropped by the recognizer without an error.
@MainActor
final class CompanionMicSource: CompanionAudioSource {

    /// When true and the system default input is a Bluetooth device, record
    /// from the built-in mic instead (see the file header for why).
    var avoidBluetooth = false

    private var engine: AVAudioEngine?
    private(set) var deviceLabel = "system default"

    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat {
        stop()
        let defaultDevice = CompanionInputDevices.defaultInput()
        var chosen = defaultDevice
        var engine = AVAudioEngine()

        if avoidBluetooth, let current = defaultDevice, current.isBluetooth,
           let builtIn = CompanionInputDevices.builtInInput() {
            if AudioDevices.applyInputDevice(builtIn.uid, to: engine), Self.formatIsUsable(engine.inputNode) {
                chosen = builtIn
                Log.companion.info("stt mic: default input \(current.label) is Bluetooth, recording from \(builtIn.label) instead")
            } else {
                // A pin that leaves the node without a valid format is the
                // -10875 path VoiceSession documents. Start over unpinned.
                Log.companion.warning("stt mic: could not switch to \(builtIn.label), staying on \(current.label)")
                engine = AVAudioEngine()
            }
        }

        let input = engine.inputNode
        var format = input.outputFormat(forBus: 0)
        if format.sampleRate <= 0 {
            // The hardware sometimes needs a moment after engine creation
            // (same guard as VoiceSession.startAudioOnEngine).
            Thread.sleep(forTimeInterval: 0.08)
            format = input.outputFormat(forBus: 0)
        }
        guard format.sampleRate > 0, format.channelCount > 0 else {
            Log.companion.error("stt start ABORT, bad input format rate=\(format.sampleRate) ch=\(format.channelCount)")
            throw CompanionSpeechError.recognizerUnavailable
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            onBuffer(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        self.engine = engine
        deviceLabel = "\(chosen?.label ?? "system default") \(Int(format.sampleRate))Hz/\(format.channelCount)ch"
        return format
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    /// Input and output formats of the node agree and carry a real rate. A tap
    /// installed with a format whose rate differs from the hardware raises an
    /// Objective-C exception, which Swift cannot catch.
    private static func formatIsUsable(_ node: AVAudioInputNode) -> Bool {
        let hardware = node.inputFormat(forBus: 0)
        let client = node.outputFormat(forBus: 0)
        return hardware.sampleRate > 0 && client.sampleRate == hardware.sampleRate && client.channelCount > 0
    }
}

/// Everything one hold captured: counters for the log line, and a bounded copy
/// of the audio so an empty on-device result can be retried on the same sound.
/// Written from the audio thread, read on the main actor.
final class CompanionHoldCapture: @unchecked Sendable {

    struct Stats: Equatable {
        var buffers = 0
        var frames = 0
        var sampleRate: Double = 0
        /// Milliseconds from `begin()` to the first buffer; nil = none arrived.
        var firstBufferMs: Int?
        /// Loudest buffer RMS in 0…1. Near zero with buffers > 0 means the
        /// device delivered silence.
        var peakLevel: Double = 0

        var audioMs: Int {
            sampleRate > 0 ? Int((Double(frames) / sampleRate * 1000).rounded()) : 0
        }
    }

    /// Keep at most this much audio for the retry. The retry only matters for
    /// short holds, and 30 s of 48 kHz float mono is already 5.8 MB.
    nonisolated static let maxRetainedSeconds: Double = 30

    private let lock = NSLock()
    private var stats = Stats()
    private var retained: [AVAudioPCMBuffer] = []
    private var retainedFrames = 0
    private var startedAt: TimeInterval = 0

    func begin() {
        lock.lock()
        stats = Stats()
        retained = []
        retainedFrames = 0
        startedAt = ProcessInfo.processInfo.systemUptime
        lock.unlock()
    }

    /// Audio thread. Returns the buffer's RMS level (0…1) for the HUD meter.
    ///
    /// The copy for the retry happens only while the cap has room, and
    /// outside the lock: past 30 s a long hold allocates nothing more on the
    /// audio thread, and the main actor never waits on a copy.
    @discardableResult
    func record(_ buffer: AVAudioPCMBuffer) -> Double {
        let level = Self.rmsLevel(buffer)
        let frames = Int(buffer.frameLength)
        lock.lock()
        if stats.sampleRate == 0 { stats.sampleRate = buffer.format.sampleRate }
        stats.buffers += 1
        stats.frames += frames
        if stats.firstBufferMs == nil {
            stats.firstBufferMs = Int(((ProcessInfo.processInfo.systemUptime - startedAt) * 1000).rounded())
        }
        stats.peakLevel = max(stats.peakLevel, level)
        let cap = Int(Self.maxRetainedSeconds * stats.sampleRate)
        let fits = retainedFrames + frames <= cap
        lock.unlock()

        guard fits, let copy = buffer.deepCopy() else { return level }
        lock.lock()
        if retainedFrames + frames <= cap {
            retained.append(copy)
            retainedFrames += frames
        }
        lock.unlock()
        return level
    }

    func snapshot() -> Stats {
        lock.lock()
        defer { lock.unlock() }
        return stats
    }

    func retainedBuffers() -> [AVAudioPCMBuffer] {
        lock.lock()
        defer { lock.unlock() }
        return retained
    }

    func reset() {
        lock.lock()
        stats = Stats()
        retained = []
        retainedFrames = 0
        lock.unlock()
    }

    /// RMS of the first channel scaled into 0…1 the way the HUD meter expects.
    nonisolated static func rmsLevel(_ buffer: AVAudioPCMBuffer) -> Double {
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        if let data = buffer.floatChannelData?[0] {
            for i in 0..<n { sum += data[i] * data[i] }
        } else if let data = buffer.int16ChannelData?[0] {
            for i in 0..<n {
                let v = Float(data[i]) / Float(Int16.max)
                sum += v * v
            }
        } else {
            return 0
        }
        let rms = sqrt(sum / Float(n))
        return Double(min(1, rms * 12))
    }

    /// One buffer holding every retained buffer back to back, plus `padMs` of
    /// silence. The recognizer closes an utterance on trailing silence, so a
    /// clip that ends mid-word finalizes more reliably with a pad.
    nonisolated static func joined(_ buffers: [AVAudioPCMBuffer], padMs: Int) -> AVAudioPCMBuffer? {
        guard let format = buffers.first?.format else { return nil }
        let same = buffers.filter { $0.format == format }
        let padFrames = Int(format.sampleRate * Double(padMs) / 1000)
        let total = same.reduce(0) { $0 + Int($1.frameLength) } + padFrames
        guard total > 0,
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total))
        else { return nil }
        let channels = Int(format.channelCount)
        var offset = 0
        for buffer in same {
            let n = Int(buffer.frameLength)
            if let src = buffer.floatChannelData, let dst = out.floatChannelData {
                for c in 0..<channels { (dst[c] + offset).update(from: src[c], count: n) }
            } else if let src = buffer.int16ChannelData, let dst = out.int16ChannelData {
                for c in 0..<channels { (dst[c] + offset).update(from: src[c], count: n) }
            } else {
                return nil
            }
            offset += n
        }
        if padFrames > 0 {
            if let dst = out.floatChannelData {
                for c in 0..<channels { (dst[c] + offset).initialize(repeating: 0, count: padFrames) }
            } else if let dst = out.int16ChannelData {
                for c in 0..<channels { (dst[c] + offset).initialize(repeating: 0, count: padFrames) }
            }
        }
        out.frameLength = AVAudioFrameCount(total)
        return out
    }
}

/// Read-only CoreAudio lookups for the hold log line and the Bluetooth check.
enum CompanionInputDevices {

    struct Device: Equatable {
        let id: AudioDeviceID
        let uid: String
        let name: String
        let transport: UInt32
        let nominalRate: Double

        var isBluetooth: Bool {
            transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
        }

        var isBuiltIn: Bool { transport == kAudioDeviceTransportTypeBuiltIn }

        var transportName: String {
            switch transport {
            case kAudioDeviceTransportTypeBuiltIn: return "built-in"
            case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
            case kAudioDeviceTransportTypeUSB: return "usb"
            case kAudioDeviceTransportTypeVirtual: return "virtual"
            case kAudioDeviceTransportTypeAggregate: return "aggregate"
            default: return "other"
            }
        }

        var label: String { "\(name) (\(transportName))" }
    }

    static func defaultInput() -> Device? {
        guard let base = AudioDevices.systemDefaultInput() else { return nil }
        return device(base)
    }

    static func builtInInput() -> Device? {
        AudioDevices.inputs().lazy.map(device).first { $0.isBuiltIn }
    }

    private static func device(_ base: AudioDevices.Device) -> Device {
        Device(
            id: base.id, uid: base.uid, name: base.name,
            transport: uint32Property(base.id, kAudioDevicePropertyTransportType) ?? 0,
            nominalRate: float64Property(base.id, kAudioDevicePropertyNominalSampleRate) ?? 0)
    }

    private static func uint32Property(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    private static func float64Property(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> Double? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }
}
