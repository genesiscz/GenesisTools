// Microphone face of GenesisTools.app:
//   GenesisTools --mic [--rate 16000] [--device <name substring>] [--list]
// Streams signed 16-bit little-endian mono PCM at --rate on stdout until stdin closes or the
// process receives SIGTERM/SIGINT. Because the bundle is the process, the microphone TCC prompt
// and grant belong to com.genesiscz.genesistools, not to the terminal that started `tools`.
// Diagnostics go to stderr as single lines prefixed "mic:"; stdout carries audio only.

import AVFoundation
import Foundation

private func micLog(_ message: String) {
    FileHandle.standardError.write(Data("mic: \(message)\n".utf8))
}

private func micUsage() -> Never {
    FileHandle.standardError.write(Data("""
    usage: GenesisTools --mic [--rate <hz>] [--device <name substring>] [--list]
      streams s16le mono PCM to stdout; --list prints the input devices and exits
    """.utf8))
    exit(64)
}

private func requestMicrophoneAccess(timeoutSeconds: Double) -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .denied, .restricted:
        return false
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { result in
            granted = result
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            micLog("microphone permission prompt timed out after \(Int(timeoutSeconds)) s")
            return false
        }
        return granted
    @unknown default:
        return false
    }
}

private func listInputDevices() -> Never {
    let session = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio, position: .unspecified)
    for device in session.devices {
        print("\(device.uniqueID)\t\(device.localizedName)")
    }
    exit(0)
}

func runMic(_ args: [String]) -> Never {
    var rate: Double = 16000
    var deviceFilter: String?
    var index = 0
    while index < args.count {
        switch args[index] {
        case "--rate":
            index += 1
            guard index < args.count, let parsed = Double(args[index]), parsed >= 8000, parsed <= 48000 else {
                micUsage()
            }
            rate = parsed
        case "--device":
            index += 1
            guard index < args.count else { micUsage() }
            deviceFilter = args[index]
        case "--list":
            listInputDevices()
        case "--help", "-h":
            micUsage()
        default:
            micUsage()
        }
        index += 1
    }

    guard requestMicrophoneAccess(timeoutSeconds: 30) else {
        micLog("microphone access denied for com.genesiscz.genesistools; grant it under System Settings > Privacy & Security > Microphone")
        exit(77)
    }

    let engine = AVAudioEngine()
    if let filter = deviceFilter {
        // AVAudioEngine follows the system default input; a specific device is selected through
        // the audio unit's current device, found by name substring.
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio, position: .unspecified)
        guard let match = session.devices.first(where: { $0.localizedName.localizedCaseInsensitiveContains(filter) }) else {
            micLog("no input device matches '\(filter)'; run --list")
            exit(66)
        }
        var deviceId = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var uid = match.uniqueID as CFString
        let status = withUnsafeMutablePointer(to: &uid) { uidPointer in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address,
                UInt32(MemoryLayout<CFString>.size), uidPointer, &size, &deviceId)
        }
        if status == noErr, deviceId != 0 {
            var selected = deviceId
            let unit = engine.inputNode.audioUnit
            if let unit {
                AudioUnitSetProperty(
                    unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                    &selected, UInt32(MemoryLayout<AudioDeviceID>.size))
            }
            micLog("input device: \(match.localizedName)")
        } else {
            micLog("could not select '\(match.localizedName)' (status \(status)); using the default input")
        }
    }

    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
        let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
    else {
        micLog("cannot build a converter from \(inputFormat) to s16le mono \(Int(rate)) Hz")
        exit(70)
    }

    let stdout = FileHandle.standardOutput
    var frames: UInt64 = 0
    input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { buffer, _ in
        let ratio = rate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var conversionError: NSError?
        converter.convert(to: out, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let conversionError {
            micLog("conversion error: \(conversionError.localizedDescription)")
            return
        }
        guard let channel = out.int16ChannelData, out.frameLength > 0 else { return }
        let bytes = Int(out.frameLength) * MemoryLayout<Int16>.size
        stdout.write(Data(bytes: channel[0], count: bytes))
        frames += UInt64(out.frameLength)
    }

    do {
        try engine.start()
    } catch {
        micLog("audio engine failed to start: \(error.localizedDescription)")
        exit(70)
    }
    micLog("streaming \(Int(rate)) Hz s16le mono from \(inputFormat.sampleRate) Hz input")

    let stop: @convention(c) (Int32) -> Void = { _ in
        exit(0)
    }
    signal(SIGTERM, stop)
    signal(SIGINT, stop)
    signal(SIGPIPE, stop)

    // stdin closing means the parent went away: stop rather than stream into nothing.
    DispatchQueue.global().async {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        micLog("stdin closed after \(frames) frames; stopping")
        exit(0)
    }

    RunLoop.main.run()
    exit(0)
}
