// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Voice/AudioDevices.swift at 2026-10-08T05:10:39+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AVFoundation
import CoreAudio
import Foundation

/// macOS audio-device enumeration + selection for the voice session.
///
/// Users pick a mic in Settings → Voice; the choice is stored as a stable
/// device UID under `app.voice.inputDeviceUID` in ~/.genesis/client.json.
/// `VoiceSession` reads it on start and pins the AVAudioEngine to that device
/// via CoreAudio's HAL AudioUnit property. If the UID is missing or the device
/// has vanished, we fall back to the system default input.
public enum AudioDevices {
    public struct Device: Identifiable, Hashable {
        public let id: AudioDeviceID
        public let uid: String
        public let name: String
    }

    /// Enumerate every attached input device (mics, aggregate, virtual — anything
    /// that reports at least one input channel).
    public static func inputs() -> [Device] {
        var propAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard
            AudioObjectGetPropertyDataSize(
                AudioObjectID(kAudioObjectSystemObject),
                &propAddress,
                0,
                nil,
                &dataSize
            ) == noErr
        else { return [] }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIds = [AudioDeviceID](repeating: 0, count: count)
        guard
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &propAddress,
                0,
                nil,
                &dataSize,
                &deviceIds
            ) == noErr
        else { return [] }

        return deviceIds.compactMap(inputDevice(for:))
    }

    /// Look up the current system default input device. Used when the user
    /// has no explicit selection or their selection is gone.
    public static func systemDefaultInput() -> Device? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &id
        ) == noErr else { return nil }
        return inputDevice(for: id)
    }

    /// Try to set an AVAudioEngine input to a specific device by UID. Returns
    /// true if the device was found and applied; false otherwise (caller can
    /// then leave the engine on the system default). Must be called BEFORE
    /// the engine is started so the AudioUnit picks it up.
    public static func applyInputDevice(_ uid: String, to engine: AVAudioEngine) -> Bool {
        guard let device = inputs().first(where: { $0.uid == uid }) else { return false }
        var id = device.id
        let audioUnit = engine.inputNode.audioUnit
        guard let audioUnit else { return false }
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &id,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        return status == noErr
    }

    /// When Voice Processing IO is on, macOS defaults to ducking every other
    /// app's audio (video, music). That duck can stick after the call if we
    /// don't clean up. Prefer keeping AEC but NOT ducking non-voice audio.
    /// Call after `setVoiceProcessingEnabled(true)`.
    @discardableResult
    public static func setDuckNonVoiceAudio(_ duck: Bool, on engine: AVAudioEngine) -> Bool {
        guard let audioUnit = engine.inputNode.audioUnit else { return false }
        // kAUVoiceIOProperty_DuckNonVoiceAudio = 2100 (AudioUnitProperties.h)
        var value: UInt32 = duck ? 1 : 0
        let status = AudioUnitSetProperty(
            audioUnit,
            2100,
            kAudioUnitScope_Global,
            0,
            &value,
            UInt32(MemoryLayout<UInt32>.size)
        )
        return status == noErr
    }

    // MARK: - Private

    /// Build a `Device` for the given AudioDeviceID iff it exposes at least
    /// one input channel. Non-input devices are filtered out.
    private static func inputDevice(for id: AudioDeviceID) -> Device? {
        guard hasInputChannels(id) else { return nil }
        guard let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
        let name = stringProperty(id, kAudioDevicePropertyDeviceNameCFString) ?? "Device"
        return Device(id: id, uid: uid, name: name)
    }

    private static func hasInputChannels(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr,
              size > 0
        else { return false }
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<UInt8>.alignment)
        defer { buffer.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, buffer) == noErr else { return false }
        let listPtr = buffer.bindMemory(to: AudioBufferList.self, capacity: 1)
        let audioList = UnsafeMutableAudioBufferListPointer(listPtr)
        for b in audioList where b.mNumberChannels > 0 {
            return true
        }
        return false
    }

    private static func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfString: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &cfString) { ptr -> OSStatus in
            AudioObjectGetPropertyData(id, &address, 0, nil, &size, ptr)
        }
        guard status == noErr else { return nil }
        return cfString as String
    }
}
