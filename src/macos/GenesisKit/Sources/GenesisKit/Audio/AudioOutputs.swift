import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// One audio output of this Mac, with the delay macOS reports for it.
public struct AudioOutputDevice: Identifiable, Hashable, Sendable {
    public let id: AudioDeviceID
    public let uid: String
    public let name: String
    public let transport: UInt32
    /// Device latency + safety offset + stream latency + one IO buffer, as CoreAudio reports them, in seconds. An AirPlay
    /// output (a HomePod) reports about 2 s; built-in speakers about 0.03 s (measured 2026-10-25).
    public let delay: TimeInterval

    public init(id: AudioDeviceID, uid: String, name: String, transport: UInt32, delay: TimeInterval) {
        self.id = id
        self.uid = uid
        self.name = name
        self.transport = transport
        self.delay = delay
    }

    public var isVirtual: Bool {
        transport == kAudioDeviceTransportTypeVirtual || transport == kAudioDeviceTransportTypeAggregate
            || transport == kAudioDeviceTransportTypeAutoAggregate
    }

    public var isBuiltIn: Bool { transport == kAudioDeviceTransportTypeBuiltIn }

    /// Bluetooth headphones or speakers (AirPods), classic or Low Energy.
    public var isBluetooth: Bool {
        transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
    }

    /// "2.0 s late" or "27 ms late".
    public var delayText: String { Self.delayText(delay) }

    public static func delayText(_ seconds: TimeInterval) -> String {
        seconds >= 1 ? String(format: "%.1f s late", seconds) : "\(Int((seconds * 1000).rounded())) ms late"
    }
}

/// The Mac's audio outputs, read from CoreAudio: the list, the system output, a faster alternative, and pinning an
/// `AVAudioEngine` to one device. Clicky plays through it; any part that plays sound can.
public enum AudioOutputs {
    /// Every device with at least one output stream.
    public static func outputs() -> [AudioOutputDevice] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap(device(for:))
    }

    public static func systemDefaultID() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr,
              id != 0 else { return nil }
        return id
    }

    /// An output to offer instead of a late one: the built-in speakers, else the connected output with the least delay.
    /// Virtual and aggregate devices are never offered: they may not reach a speaker.
    public static func suggestion(instead late: AudioOutputDevice, outputs: [AudioOutputDevice],
                                  limit: TimeInterval) -> AudioOutputDevice? {
        let candidates = outputs.filter { $0.uid != late.uid && !$0.isVirtual && $0.delay < limit }
        return candidates.first(where: \.isBuiltIn) ?? candidates.min { $0.delay < $1.delay }
    }

    /// Makes `engine` play on `device` from its next start (call it while the engine is stopped). Returns false when
    /// CoreAudio refused or the engine renders offline.
    @discardableResult
    public static func pin(_ engine: AVAudioEngine, to device: AudioDeviceID) -> Bool {
        guard !engine.isInManualRenderingMode, let unit = engine.outputNode.audioUnit else { return false }
        var device = device
        return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device,
                                    UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
    }

    // MARK: - CoreAudio

    private static func device(for id: AudioDeviceID) -> AudioOutputDevice? {
        let streams = outputStreams(id)
        guard !streams.isEmpty, let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
        let output = kAudioObjectPropertyScopeOutput
        let global = kAudioObjectPropertyScopeGlobal
        let rate = value(id, kAudioDevicePropertyNominalSampleRate, global, Float64(0)) ?? 0
        let frames = (value(id, kAudioDevicePropertyLatency, output, UInt32(0)) ?? 0)
            + (value(id, kAudioDevicePropertySafetyOffset, output, UInt32(0)) ?? 0)
            + (value(id, kAudioDevicePropertyBufferFrameSize, global, UInt32(0)) ?? 0)
            + (value(streams[0], kAudioStreamPropertyLatency, global, UInt32(0)) ?? 0)
        return AudioOutputDevice(
            id: id, uid: uid, name: string(id, kAudioDevicePropertyDeviceNameCFString) ?? "Output",
            transport: value(id, kAudioDevicePropertyTransportType, global, UInt32(0)) ?? 0,
            delay: rate > 0 ? Double(frames) / rate : 0)
    }

    private static func outputStreams(_ id: AudioDeviceID) -> [AudioStreamID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var streams = [AudioStreamID](repeating: 0, count: Int(size) / MemoryLayout<AudioStreamID>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &streams) == noErr else { return [] }
        return streams
    }

    private static func value<T: BinaryInteger & Sendable>(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
                                                           _ scope: AudioObjectPropertyScope, _ initial: T) -> T? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var result = initial
        var size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &result) == noErr ? result : nil
    }

    private static func value(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
                              _ scope: AudioObjectPropertyScope, _ initial: Float64) -> Float64? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var result = initial
        var size = UInt32(MemoryLayout<Float64>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &result) == noErr ? result : nil
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var text: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &text) == noErr, let text else { return nil }
        return text.takeRetainedValue() as String
    }
}

/// Calls `changed` on the main queue when the system output or the list of devices changes.
@MainActor
public final class AudioOutputMonitor {
    private var listeners: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    public init(changed: @escaping @MainActor () -> Void) {
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices] {
            var address = AudioObjectPropertyAddress(
                mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            let block: AudioObjectPropertyListenerBlock = { _, _ in
                MainActor.assumeIsolated { changed() }
            }
            if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block) == noErr {
                listeners.append((address, block))
            }
        }
    }

    public func stop() {
        for (address, block) in listeners {
            var address = address
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block)
        }
        listeners.removeAll()
    }
}
