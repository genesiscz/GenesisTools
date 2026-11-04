import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit
import SnapshotSupport

// MARK: - audio-devices

private func audioProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                              scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, initial: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
    return status == noErr ? value : nil
}

private func audioString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

private func audioChannels(_ object: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

struct AudioDevice {
    let objectID: AudioObjectID
    let uid: String
    let name: String
    let inputChannels: Int
    let outputChannels: Int
}

func audioDevices() -> [AudioDevice] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        guard let uid = audioString(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return AudioDevice(objectID: id, uid: uid, name: audioString(id, kAudioObjectPropertyName) ?? uid,
                           inputChannels: audioChannels(id, scope: kAudioObjectPropertyScopeInput),
                           outputChannels: audioChannels(id, scope: kAudioObjectPropertyScopeOutput))
    }
}

/// Inputs and outputs. `id` is the device UID, the value `--mic-device` and `set-mic` take (ScreenCaptureKit's
/// `microphoneCaptureDeviceID` is the capture device's unique id, which is this UID for audio devices).
func cmdAudioDevices() {
    let system = AudioObjectID(kAudioObjectSystemObject)
    let defaultInput = audioProperty(system, kAudioHardwarePropertyDefaultInputDevice, initial: AudioObjectID(0))
    let defaultOutput = audioProperty(system, kAudioHardwarePropertyDefaultOutputDevice, initial: AudioObjectID(0))
    let devices = audioDevices()
    func row(_ device: AudioDevice, channels: Int, isDefault: Bool) -> [String: Any] {
        ["id": device.uid, "audioObjectId": device.objectID, "name": device.name, "channels": channels, "default": isDefault]
    }
    jsonOutput([
        "ok": true,
        "inputs": devices.filter { $0.inputChannels > 0 }.map { row($0, channels: $0.inputChannels, isDefault: $0.objectID == defaultInput) },
        "outputs": devices.filter { $0.outputChannels > 0 }.map { row($0, channels: $0.outputChannels, isDefault: $0.objectID == defaultOutput) },
    ])
}

// MARK: - recording

private func sampleBufferPeak(_ buffer: CMSampleBuffer) -> Float {
    guard let format = CMSampleBufferGetFormatDescription(buffer),
          let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return 0 }
    var blockBuffer: CMBlockBuffer?
    var size = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &size, bufferListOut: nil,
                                                            bufferListSize: 0, blockBufferAllocator: nil,
                                                            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    guard size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let listPointer = raw.assumingMemoryBound(to: AudioBufferList.self)
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        buffer, bufferListSizeNeededOut: nil, bufferListOut: listPointer, bufferListSize: size,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer) == noErr else { return 0 }
    let isFloat = description.mFormatFlags & kAudioFormatFlagIsFloat != 0
    var peak: Float = 0
    for audio in UnsafeMutableAudioBufferListPointer(listPointer) {
        guard let data = audio.mData else { continue }
        if isFloat && description.mBitsPerChannel == 32 {
            let count = Int(audio.mDataByteSize) / MemoryLayout<Float>.size
            peak = max(peak, peakAmplitude(float32: UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: count)))
        } else if !isFloat && description.mBitsPerChannel == 16 {
            let count = Int(audio.mDataByteSize) / MemoryLayout<Int16>.size
            peak = max(peak, peakAmplitude(int16: UnsafeBufferPointer(start: data.assumingMemoryBound(to: Int16.self), count: count)))
        }
    }
    return peak
}

/// The same audio timing and format, all samples zero: muting keeps the timeline instead of leaving a gap.
private func silentCopy(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
    guard let format = CMSampleBufferGetFormatDescription(buffer), let data = CMSampleBufferGetDataBuffer(buffer) else { return nil }
    let length = CMBlockBufferGetDataLength(data)
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: length,
                                             blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
                                             dataLength: length, flags: kCMBlockBufferAssureMemoryNowFlag,
                                             blockBufferOut: &block) == noErr, let block,
          CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: length) == noErr else {
        return nil
    }
    var out: CMSampleBuffer?
    guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
        allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
        sampleCount: CMSampleBufferGetNumSamples(buffer), presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(buffer),
        packetDescriptions: nil, sampleBufferOut: &out) == noErr else { return nil }
    return out
}

/// AAC settings for one audio track; the writer converts the captured PCM.
func aacSettings(channels: Int) -> [String: Any] {
    var layout = AudioChannelLayout()
    layout.mChannelLayoutTag = channels == 1 ? kAudioChannelLayoutTag_Mono : kAudioChannelLayoutTag_Stereo
    return [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: channels,
        AVEncoderBitRateKey: channels == 1 ? 96_000 : 160_000,
        AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
    ]
}

/// The channel count each source is written with.
func audioChannelCount(_ source: CaptureAudioSource) -> Int {
    source == .mic ? 1 : 2
}

/// One audio source: its movie track, its optional `.m4a` sidecar, the mute state and the measurements.
private final class AudioTrack {
    let source: CaptureAudioSource
    let movieInput: AVAssetWriterInput?
    let sidecarURL: URL?
    private var sidecar: AVAssetWriter?
    private var sidecarInput: AVAssetWriterInput?
    var muted = false
    var peak: Float = 0
    var first: CMTime?
    var end: CMTime?
    var buffers = 0
    var movieAppends = 0
    var failures: [String] = []
    /// Muted stretches as host-clock start and end.
    var mutedSpans: [(start: CMTime, end: CMTime?)] = []

    init(source: CaptureAudioSource, movieInput: AVAssetWriterInput?, sidecarURL: URL?) {
        self.source = source
        self.movieInput = movieInput
        self.sidecarURL = sidecarURL
    }

    func appendSidecar(_ buffer: CMSampleBuffer, at time: CMTime) {
        guard let sidecarURL else { return }
        if sidecar == nil {
            do {
                let writer = try AVAssetWriter(outputURL: sidecarURL, fileType: .m4a)
                let input = AVAssetWriterInput(mediaType: .audio, outputSettings: aacSettings(channels: audioChannelCount(source)))
                input.expectsMediaDataInRealTime = true
                writer.add(input)
                guard writer.startWriting() else {
                    throw writer.error ?? NSError(domain: "ax-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "the writer refused to start"])
                }
                writer.startSession(atSourceTime: time)
                sidecar = writer
                sidecarInput = input
            } catch {
                failures.append("the \(source.rawValue) sidecar could not start: \(error.localizedDescription)")
                return
            }
        }
        if let sidecarInput, sidecarInput.isReadyForMoreMediaData, !sidecarInput.append(buffer), failures.isEmpty {
            failures.append("the \(source.rawValue) sidecar refused audio: \(sidecar?.error?.localizedDescription ?? "no error reported")")
        }
    }

    func finishSidecar() {
        guard let sidecar, let sidecarInput else { return }
        if let end {
            sidecar.endSession(atSourceTime: end)
        }
        sidecarInput.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        sidecar.finishWriting { done.signal() }
        if done.wait(timeout: .now() + 10) == .timedOut || sidecar.status != .completed {
            failures.append("the \(source.rawValue) sidecar did not finish: \(sidecar.error?.localizedDescription ?? "timed out")")
        }
    }

    var sidecarWritten: Bool { sidecar?.status == .completed }
}

/// Receives ScreenCaptureKit's system audio and microphone buffers on its own queue, so a slow PNG on the frame
/// queue never holds audio back, and writes them to the movie tracks and the sidecars.
@available(macOS 13.0, *)
final class NativeAudio: NSObject, SCStreamOutput {
    let queue = DispatchQueue(label: "ax-tool.record.audio", qos: .userInitiated)
    let sources: [CaptureAudioSource]
    private var tracks: [CaptureAudioSource: AudioTrack] = [:]
    private let lock = NSLock()
    private var movieStart: CMTime?
    private var paused = false
    private var closed = false

    init(sources: [CaptureAudioSource], movieInputs: [CaptureAudioSource: AVAssetWriterInput], sidecarDirectory: URL?) {
        self.sources = sources
        for source in sources {
            tracks[source] = AudioTrack(source: source, movieInput: movieInputs[source],
                                        sidecarURL: sidecarDirectory?.appendingPathComponent("audio-\(source.rawValue).m4a"))
        }
    }

    /// Called on the frame queue when the movie session starts; audio before it is not in the movie.
    func movieStarted(at time: CMTime) {
        lock.lock()
        movieStart = time
        lock.unlock()
    }

    private var movieStartTime: CMTime? {
        lock.lock()
        defer { lock.unlock() }
        return movieStart
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        let source: CaptureAudioSource
        if type == .audio {
            source = .system
        } else if #available(macOS 15.0, *), type == .microphone {
            source = .mic
        } else {
            return
        }
        guard !closed, !paused, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer), let track = tracks[source] else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let buffer: CMSampleBuffer
        if track.muted {
            guard let silent = silentCopy(sampleBuffer) else {
                if !track.failures.contains("could not silence muted audio") {
                    track.failures.append("could not silence muted audio")
                }
                return
            }
            buffer = silent
            if track.mutedSpans.last.map({ $0.end != nil }) ?? true {
                track.mutedSpans.append((time, nil))
            }
        } else {
            buffer = sampleBuffer
            if let last = track.mutedSpans.last, last.end == nil {
                track.mutedSpans[track.mutedSpans.count - 1].end = time
            }
            track.peak = max(track.peak, sampleBufferPeak(sampleBuffer))
        }
        if track.first == nil {
            track.first = time
        }
        track.end = CMTimeAdd(time, CMSampleBufferGetDuration(sampleBuffer))
        track.buffers += 1
        if let input = track.movieInput, let start = movieStartTime, CMTimeCompare(time, start) >= 0,
           input.isReadyForMoreMediaData {
            if input.append(buffer) {
                track.movieAppends += 1
            } else if !track.failures.contains(where: { $0.hasPrefix("the movie") }) {
                track.failures.append("the movie refused \(source.rawValue) audio")
            }
        }
        track.appendSidecar(buffer, at: time)
    }

    func setMuted(_ source: CaptureAudioSource, _ muted: Bool) -> Bool {
        queue.sync {
            guard let track = tracks[source] else { return false }
            track.muted = muted
            return true
        }
    }

    func setPaused(_ value: Bool) {
        queue.async { [self] in paused = value }
    }

    var mutedState: [String: Bool] {
        queue.sync { Dictionary(uniqueKeysWithValues: tracks.map { ($0.key.rawValue, $0.value.muted) }) }
    }

    /// Stops taking buffers and finishes the sidecars. Call after the stream stopped, before the movie finishes.
    func close() {
        queue.sync { closed = true }
        for track in tracks.values {
            track.movieInput?.markAsFinished()
            track.finishSidecar()
        }
    }

    /// The `tracks` entries of the result; times are relative to `origin`, the first video frame.
    func summaries(origin: CMTime?) -> [[String: Any]] {
        queue.sync {
            sources.compactMap { source -> [String: Any]? in
                guard let track = tracks[source] else { return nil }
                func ms(_ time: CMTime) -> Int {
                    Int((CMTimeGetSeconds(CMTimeSubtract(time, origin ?? track.first ?? time)) * 1000).rounded())
                }
                var row: [String: Any] = ["source": source.rawValue, "channels": audioChannelCount(source), "sampleRate": 48_000,
                                          "buffers": track.buffers, "inMovie": track.movieInput != nil && track.movieAppends > 0,
                                          "peakDbfs": peakDbfs(track.peak) ?? NSNull(), "muted": track.muted]
                if let first = track.first, let end = track.end {
                    row["durationMs"] = Int((CMTimeGetSeconds(CMTimeSubtract(end, first)) * 1000).rounded())
                    row["startMs"] = ms(first)
                } else {
                    row["durationMs"] = 0
                }
                row["mutedSpans"] = track.mutedSpans.map { [ms($0.start), ms($0.end ?? track.end ?? $0.start)] }
                if track.sidecarWritten, let url = track.sidecarURL {
                    row["file"] = url.lastPathComponent
                    row["path"] = url.path
                }
                if !track.failures.isEmpty {
                    row["warnings"] = track.failures
                }
                return row
            }
        }
    }
}
