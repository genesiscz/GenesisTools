import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import SnapshotSupport

private func audioInputError(_ message: String) -> NSError {
    NSError(domain: "ax-tool.audio-input", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// The input devices for audio-record --without-screen. Both feed the ordinary segment writer on its queue.
final class IndependentAudio: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let audio: SegmentedAudio
    private var microphone: AVCaptureSession?
    private var interruption: NSObjectProtocol?
    private var stopTap: (() -> Void)?

    init(audio: SegmentedAudio) { self.audio = audio }

    func start(_ source: CaptureAudioSource, micDevice: String?) throws {
        switch source {
        case .mic:
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                throw audioInputError("Microphone access is not granted.")
            }
            let session = AVCaptureSession()
            let output = AVCaptureAudioDataOutput()
            output.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM]
            output.setSampleBufferDelegate(self, queue: audio.queue)
            guard let device = micDevice.map({ AVCaptureDevice(uniqueID: $0) }) ?? AVCaptureDevice.default(for: .audio) else {
                throw audioInputError("The microphone is unavailable.")
            }
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw audioInputError("Cannot open the microphone input.") }
            session.addInput(input)
            guard session.canAddOutput(output) else { throw audioInputError("Cannot open the microphone output.") }
            session.addOutput(output)
            session.startRunning()
            guard session.isRunning else { throw audioInputError("Microphone capture did not start.") }
            microphone = session
            interruption = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification,
                object: session, queue: nil) { [weak self] note in
                let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
                self?.audio.failed?(error?.localizedDescription ?? "Microphone capture stopped.")
            }
        case .system:
            guard #available(macOS 14.4, *) else {
                throw audioInputError("System Audio Recording without Screen Recording requires macOS 14.4 or newer.")
            }
            let tap = SystemAudioTap()
            try tap.start(audio)
            stopTap = { tap.stop() }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        audio.append(sampleBuffer, source: .mic)
    }

    func switchMicrophone(_ id: String) throws {
        guard let session = microphone, let old = session.inputs.first,
              let device = AVCaptureDevice(uniqueID: id) else { throw audioInputError("Microphone unavailable.") }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.removeInput(old)
        guard session.canAddInput(input) else {
            session.addInput(old)
            throw audioInputError("Cannot open microphone \(id).")
        }
        session.addInput(input)
    }

    func stop() {
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        microphone?.stopRunning()
        stopTap?()
        stopTap = nil
    }
}

/// Core Audio authorizes system-output taps independently. No display, window list or SCStream is involved.
@available(macOS 14.4, *)
private final class SystemAudioTap {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw audioInputError("\(operation) (Core Audio \(status)).") }
    }

    func start(_ audio: SegmentedAudio) throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "Meeting system sound"
        description.isPrivate = true
        try check(AudioHardwareCreateProcessTap(description, &tap), "Could not open the System Audio Recording tap")
        do {
            var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var asbd = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout.size(ofValue: asbd))
            try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd), "Could not read the tap format")
            guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mBytesPerFrame > 0,
                  let format = AVAudioFormat(streamDescription: &asbd) else {
                throw audioInputError("Unsupported system audio format.")
            }
            let aggregate: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Meeting system sound",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString]],
            ]
            try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "Could not create the audio input")
            let bytesPerFrame = asbd.mBytesPerFrame
            let delivery = DispatchQueue(label: "ax-tool.audio-session.tap")
            try check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, delivery) { _, input, time, _, _ in
                let count = Int(input.pointee.mBuffers.mDataByteSize / bytesPerFrame)
                guard count > 0 else { return }
                var buffer: CMSampleBuffer?
                var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(format.sampleRate)),
                    presentationTimeStamp: CMClockMakeHostTimeFromSystemUnits(time.pointee.mHostTime), decodeTimeStamp: .invalid)
                guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
                    makeDataReadyCallback: nil, refcon: nil, formatDescription: format.formatDescription, sampleCount: count,
                    sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
                    sampleBufferOut: &buffer) == noErr, let buffer,
                    CMSampleBufferSetDataBufferFromAudioBufferList(buffer, blockBufferAllocator: kCFAllocatorDefault,
                        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: input) == noErr,
                    CMSampleBufferSetDataReady(buffer) == noErr else {
                    audio.failed?("Could not copy a system audio buffer.")
                    return
                }
                audio.queue.async { audio.append(buffer, source: .system) }
            }, "Could not connect the system audio writer")
            try check(AudioDeviceStart(device, proc), "Could not start System Audio Recording")
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        if let proc {
            AudioDeviceStop(device, proc)
            AudioDeviceDestroyIOProcID(device, proc)
            self.proc = nil
        }
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device); device = kAudioObjectUnknown }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = kAudioObjectUnknown }
    }
}
