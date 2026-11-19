import AVFoundation
import Accelerate
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

/// Names only. An explicitly selected microphone remains the input even if the system default changes.
func levelDeviceNames(micID: String?) -> (input: String?, output: String?) {
    func defaultName(_ selector: AudioObjectPropertySelector) -> String? {
        guard let id = audioProperty(AudioObjectID(kAudioObjectSystemObject), selector, initial: AudioObjectID(0))
        else { return nil }
        return audioString(id, kAudioObjectPropertyName)
    }
    let input: String?
    if let micID { input = AVCaptureDevice(uniqueID: micID)?.localizedName }
    else { input = defaultName(kAudioHardwarePropertyDefaultInputDevice) }
    return (input, defaultName(kAudioHardwarePropertyDefaultOutputDevice))
}

/// Sum squares across every PCM plane, normalized to full scale. Keep the count so unequal buffers have equal
/// weight per sample. Capture formats not understood here are reported as unavailable.
func audioSamplePower(_ buffer: CMSampleBuffer) -> (sum: Double, count: Int)? {
    guard let format = CMSampleBufferGetFormatDescription(buffer),
          let desc = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          desc.mFormatID == kAudioFormatLinearPCM, desc.mChannelsPerFrame > 0,
          desc.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 else { return nil }
    let list = AudioBufferList.allocate(maximumBuffers: Int(desc.mChannelsPerFrame))
    defer { free(list.unsafeMutablePointer) }
    var backing: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: nil,
        bufferListOut: list.unsafeMutablePointer, bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: Int(desc.mChannelsPerFrame)),
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &backing) == noErr else { return nil }
    return withExtendedLifetime(backing) {
        var sum = 0.0, count = 0
        let floating = desc.mFormatFlags & kAudioFormatFlagIsFloat != 0
        for plane in list {
            guard let data = plane.mData else { continue }
            if floating && desc.mBitsPerChannel == 32 {
                let n = Int(plane.mDataByteSize) / 4
                var power: Float = 0
                vDSP_svesq(data.assumingMemoryBound(to: Float.self), 1, &power, vDSP_Length(n))
                sum += Double(power)
                count += n
            } else if !floating && desc.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0 {
                let stride = Int(desc.mBytesPerFrame) / (desc.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 ? Int(desc.mChannelsPerFrame) : 1)
                guard (1...4).contains(stride), desc.mBitsPerChannel > 0, desc.mBitsPerChannel <= stride * 8 else { return nil }
                let bytes = data.assumingMemoryBound(to: UInt8.self)
                let n = Int(plane.mDataByteSize) / stride
                let bits = desc.mFormatFlags & kAudioFormatFlagIsAlignedHigh == 0 ? Int(desc.mBitsPerChannel) : stride * 8
                for i in 0..<n {
                    var word: UInt32 = 0
                    for j in 0..<stride { word |= UInt32(bytes[i * stride + j]) << (8 * j) }
                    let sample = Double(Int32(bitPattern: word << (32 - bits))) / 2147483648
                    sum += sample * sample
                }
                count += n
            } else { return nil }
        }
        return count > 0 && sum.isFinite ? (sum, count) : nil
    }
}

/// Lives on the same serial queue as the audio inputs. Only aggregate power leaves the process.
final class AudioLevelMeter {
    private var sums: [CaptureAudioSource: Double] = [:]
    private var counts: [CaptureAudioSource: Int] = [:]
    private var timer: DispatchSourceTimer?
    private let delivery = DispatchQueue(label: "ax-tool.audio-levels.delivery", qos: .utility)
    private let deliveryAvailable = DispatchSemaphore(value: 1)
    private let emitRow: ([String: Any]) -> Void
    // Accessed only on delivery, away from the recording's sample queue.
    private var devices: (input: String?, output: String?) = (nil, nil)
    private var lastMicID: String?
    private var nextDeviceRead = Date.distantPast
    var micID: String?

    init(queue: DispatchQueue, micID: String?, emitRow: @escaping ([String: Any]) -> Void = CaptureEvents.emit) {
        self.micID = micID
        self.emitRow = emitRow
        let timer = DispatchSource.makeTimerSource(queue: queue)
        self.timer = timer
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.emit() }
        timer.resume()
    }

    deinit { timer?.cancel() }

    func append(_ buffer: CMSampleBuffer, source: CaptureAudioSource, muted: Bool) {
        guard let power = audioSamplePower(buffer) else { return }
        counts[source, default: 0] += power.count
        if !muted { sums[source, default: 0] += power.sum }
    }

    private func emit() {
        let now = Date()
        func rms(_ source: CaptureAudioSource) -> Double? {
            guard let n = counts[source], n > 0 else { return nil }
            return sqrt((sums[source] ?? 0) / Double(n))
        }
        let mic = rms(.mic), system = rms(.system), selectedMic = micID
        sums.removeAll(keepingCapacity: true)
        counts.removeAll(keepingCapacity: true)
        // Drop a meter update if the supervisor is slow. Neither a blocked pipe nor a device lookup can stall audio.
        guard deliveryAvailable.wait(timeout: .now()) == .success else { return }
        delivery.async { [self] in
            defer { deliveryAvailable.signal() }
            if now >= nextDeviceRead || selectedMic != lastMicID {
                devices = levelDeviceNames(micID: selectedMic)
                lastMicID = selectedMic
                nextDeviceRead = now.addingTimeInterval(2)
            }
            emitRow(["event": "levels", "atMs": now.timeIntervalSince1970 * 1000,
                                "mic": mic as Any? ?? NSNull(), "system": system as Any? ?? NSNull(),
                                "input": devices.input as Any? ?? NSNull(), "output": devices.output as Any? ?? NSNull()])
        }
    }
}

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

typealias AudioRangeCopy = (CMSampleBuffer, CFRange) -> (status: OSStatus, buffer: CMSampleBuffer?)

func copyAudioRange(_ buffer: CMSampleBuffer, _ range: CFRange) -> (status: OSStatus, buffer: CMSampleBuffer?) {
    var copy: CMSampleBuffer?
    let status = CMSampleBufferCopySampleBufferForRange(allocator: kCFAllocatorDefault, sampleBuffer: buffer,
        sampleRange: range, sampleBufferOut: &copy)
    if status == noErr, let copy { return (status, copy) }
    return copyPCMFrames(buffer, range, refused: status)
}

/// Some PCM buffers refuse CoreMedia's range copy. Copy each plane's frames, never a contiguous byte range
/// across channels: ScreenCaptureKit's stereo output is non-interleaved. A failure answers `refused`.
func copyPCMFrames(_ buffer: CMSampleBuffer, _ range: CFRange, refused status: OSStatus) -> (status: OSStatus, buffer: CMSampleBuffer?) {
    var copy: CMSampleBuffer?
    let count = CMSampleBufferGetNumSamples(buffer)
    guard range.location >= 0, range.length > 0, range.location <= count - range.length,
          let format = CMSampleBufferGetFormatDescription(buffer),
          let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          description.mFormatID == kAudioFormatLinearPCM, description.mSampleRate > 0 else { return (status, nil) }
    let list = AudioBufferList.allocate(maximumBuffers: Int(description.mChannelsPerFrame))
    defer { free(list.unsafeMutablePointer) }
    var block: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: nil,
        bufferListOut: list.unsafeMutablePointer,
        bufferListSize: MemoryLayout<AudioBufferList>.size + max(0, list.count - 1) * MemoryLayout<AudioBuffer>.size,
        blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
        flags: 0, blockBufferOut: &block) == noErr else { return (status, nil) }
    for index in list.indices {
        let bytes = Int(list[index].mDataByteSize) / count
        guard bytes > 0, let data = list[index].mData else { return (status, nil) }
        list[index].mData = data.advanced(by: range.location * bytes)
        list[index].mDataByteSize = UInt32(range.length * bytes)
    }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(description.mSampleRate)),
        presentationTimeStamp: CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(buffer),
            CMTime(seconds: Double(range.location) / description.mSampleRate, preferredTimescale: 1_000_000_000)),
        decodeTimeStamp: .invalid)
    guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: format, sampleCount: range.length,
        sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
        sampleBufferOut: &copy) == noErr, let copy,
        CMSampleBufferSetDataBufferFromAudioBufferList(copy, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0,
            bufferList: list.unsafeMutablePointer) == noErr else { return (status, nil) }
    // The buffer was created not ready: it is a success only once its data is marked ready.
    if !CMSampleBufferDataIsReady(copy) {
        let ready = CMSampleBufferSetDataReady(copy)
        guard ready == noErr, CMSampleBufferDataIsReady(copy) else { return (ready == noErr ? status : ready, nil) }
    }
    return (noErr, copy)
}

/// The same audio timing and format, all samples zero: muting keeps the timeline instead of leaving a gap.
func silentCopy(_ buffer: CMSampleBuffer, samples: Int? = nil, at: CMTime? = nil) -> CMSampleBuffer? {
    guard let format = CMSampleBufferGetFormatDescription(buffer), let data = CMSampleBufferGetDataBuffer(buffer) else { return nil }
    let count = CMSampleBufferGetNumSamples(buffer)
    guard count > 0 else { return nil }
    let length = CMBlockBufferGetDataLength(data) / count * (samples ?? count)
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
        sampleCount: samples ?? count, presentationTimeStamp: at ?? CMSampleBufferGetPresentationTimeStamp(buffer),
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
final class AudioTrack {
    let source: CaptureAudioSource
    let movieInput: AVAssetWriterInput?
    let sidecarURL: URL?
    private var sidecar: AVAssetWriter?
    private var sidecarInput: AVAssetWriterInput?
    private var sidecarStartFailed = false
    /// Only continuous sessions fragment open files, so an interrupted segment remains recoverable.
    var fragmentInterval: CMTime?
    var muted = false
    var peak: Float = 0
    var first: CMTime?
    var zeroAt: String?
    var end: CMTime?
    var buffers = 0
    var movieAppends = 0
    var failures: [String] = []
    /// Muted stretches as host-clock start and end.
    var mutedSpans: [(start: CMTime, end: CMTime?)] = []
    var fileTimeline = AudioFileTimeline()
    private var expected: CMTime?
    /// The most silence one capture callback encodes. A longer gap is filled over the next callbacks; audio
    /// that arrives before the fill reaches it is dropped and becomes part of the lost span, so file time stays
    /// capture time. `finishSidecar` fills the rest without this limit, off the capture queue.
    static let fillSecondsPerAppend = 2.0
    private var sidecarEnd: CMTime?
    private var silenceTemplate: CMSampleBuffer?
    private var losses: [(start: Double, end: Double)] = []
    // The writer operations are replaceable so refusal is reproducible with generated PCM, without a device.
    var sidecarReady: (AVAssetWriterInput) -> Bool = { $0.isReadyForMoreMediaData }
    var sidecarAppend: (AVAssetWriterInput, CMSampleBuffer) -> Bool = { $0.append($1) }
    var rangeCopy: AudioRangeCopy = copyAudioRange
    var sidecarFailed: Bool { sidecarStartFailed || sidecar?.status == .failed }
    var lostSpans: [[Int]] {
        losses.map { [Int(($0.start * 1000).rounded()), Int(($0.end * 1000).rounded())] }
    }

    init(source: CaptureAudioSource, movieInput: AVAssetWriterInput?, sidecarURL: URL?) {
        self.source = source
        self.movieInput = movieInput
        self.sidecarURL = sidecarURL
    }

    func appendSidecar(_ buffer: CMSampleBuffer, at time: CMTime) {
        guard let sidecarURL, !sidecarStartFailed,
              let format = CMSampleBufferGetFormatDescription(buffer),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              description.mSampleRate > 0 else { return }
        let rate = description.mSampleRate
        let count = CMSampleBufferGetNumSamples(buffer)
        let bufferEnd = CMTimeAdd(time, CMTime(seconds: Double(count) / rate, preferredTimescale: 1_000_000_000))
        if sidecarEnd == nil || CMTimeCompare(bufferEnd, sidecarEnd!) > 0 { sidecarEnd = bufferEnd }
        silenceTemplate = buffer
        if sidecar == nil {
            do {
                let writer = try AVAssetWriter(outputURL: sidecarURL, fileType: .m4a)
                if let fragmentInterval {
                    writer.movieFragmentInterval = fragmentInterval
                }
                let input = AVAssetWriterInput(mediaType: .audio, outputSettings: aacSettings(channels: audioChannelCount(source)))
                input.expectsMediaDataInRealTime = true
                writer.add(input)
                guard writer.startWriting() else {
                    throw writer.error ?? NSError(domain: "ax-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "the writer refused to start"])
                }
                writer.startSession(atSourceTime: time)
                sidecar = writer
                sidecarInput = input
                expected = time
            } catch {
                sidecarStartFailed = true
                failures.append("the \(source.rawValue) sidecar could not start: \(error.localizedDescription)")
                return
            }
        }
        guard let expected else { return }
        let delta = CMTimeGetSeconds(CMTimeSubtract(time, expected))
        if delta > 0.005, !fillSidecar(to: time, using: buffer, rate: rate,
                                       limit: Int(Self.fillSecondsPerAppend * rate)) { return }
        var samples = buffer
        if delta < -0.005 {
            let skip = min(count, Int((-delta * rate).rounded()))
            guard skip < count else { return }
            let copy = rangeCopy(buffer, CFRange(location: skip, length: count - skip))
            guard copy.status == noErr, let trimmed = copy.buffer else {
                let category = "the \(source.rawValue) sidecar could not trim overlapping audio:"
                let before = failures.count
                appendCaptureFailure("\(category) range copy status \(copy.status); missing samples are kept as silence",
                    category: category, to: &failures)
                if failures.count > before, let message = failures.last {
                    CaptureEvents.emit(["event": "warning", "message": message])
                }
                return
            }
            samples = trimmed
        }
        _ = writeSidecar(samples, rate: rate, lost: false)
    }

    /// Answers true only after the entire missing interval was written. Refusal, or more missing samples than
    /// `limit`, leaves `expected` at the last success.
    private func fillSidecar(to time: CMTime, using buffer: CMSampleBuffer, rate: Double, limit: Int = .max) -> Bool {
        var budget = limit
        while let expected {
            let missing = Int((CMTimeGetSeconds(CMTimeSubtract(time, expected)) * rate).rounded())
            if missing <= 0 { return true }
            guard budget > 0 else { return false }
            // Bound allocation even after a long capture stall; no waiting or queue of captured buffers.
            let samples = min(missing, Int(rate), budget)
            guard let silence = silentCopy(buffer, samples: samples, at: expected),
                  writeSidecar(silence, rate: rate, lost: true) else { return false }
            budget -= samples
        }
        return false
    }

    private func writeSidecar(_ buffer: CMSampleBuffer, rate: Double, lost: Bool) -> Bool {
        guard let sidecarInput, sidecarReady(sidecarInput), let expected else { return false }
        var timing = CMSampleTimingInfo(duration: CMTime(seconds: 1 / rate, preferredTimescale: 1_000_000_000),
                                        presentationTimeStamp: expected, decodeTimeStamp: .invalid)
        var timed: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: buffer,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &timed) == noErr,
              let timed else { return false }
        guard sidecarAppend(sidecarInput, timed) else {
            // An earlier movie warning must not hide the sidecar's own failure; repeats of it are dropped.
            let category = "the \(source.rawValue) sidecar refused audio:"
            appendCaptureFailure("\(category) \(sidecar?.error?.localizedDescription ?? "no error reported")",
                                 category: category, to: &failures)
            return false
        }
        let start = fileTimeline.seconds
        let count = CMSampleBufferGetNumSamples(buffer)
        fileTimeline.append(sampleCount: count, sampleRate: rate, muted: !lost && muted)
        self.expected = CMTimeAdd(expected, CMTime(seconds: Double(count) / rate, preferredTimescale: 1_000_000_000))
        if lost {
            if let last = losses.last, abs(last.end - start) < 0.5 / rate {
                losses[losses.count - 1].end = fileTimeline.seconds
            } else {
                losses.append((start, fileTimeline.seconds))
            }
        }
        return true
    }

    func finishSidecar() {
        guard let sidecar, let sidecarInput else { return }
        // Also preserve a refused final buffer; no later capture callback is needed to reveal this loss.
        let drained = DispatchSemaphore(value: 0)
        sidecarInput.requestMediaDataWhenReady(on: DispatchQueue(label: "ax-tool.audio-sidecar.finish")) { [self] in
            if let end = sidecarEnd, let buffer = silenceTemplate,
               let format = CMSampleBufferGetFormatDescription(buffer),
               let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
               !fillSidecar(to: end, using: buffer, rate: description.mSampleRate), sidecar.status == .writing {
                return
            }
            if let expected { sidecar.endSession(atSourceTime: expected) }
            sidecarInput.markAsFinished()
            drained.signal()
        }
        guard drained.wait(timeout: .now() + 10) == .success else {
            sidecar.cancelWriting()
            failures.append("the \(source.rawValue) sidecar could not preserve its final samples within 10s")
            return
        }
        let done = DispatchSemaphore(value: 0)
        sidecar.finishWriting { done.signal() }
        if done.wait(timeout: .now() + 10) == .timedOut || sidecar.status != .completed {
            failures.append("the \(source.rawValue) sidecar did not finish: \(sidecar.error?.localizedDescription ?? "timed out")")
        }
    }

    var sidecarWritten: Bool { sidecar?.status == .completed }

    /// The capture time of the next sample the sidecar expects; nil before its writer started.
    var sidecarNextTime: CMTime? { expected }

    /// The sidecar ends no earlier than `time`: `finishSidecar` fills the missing samples with silence.
    func extendSidecar(to time: CMTime) {
        if sidecarEnd == nil || CMTimeCompare(time, sidecarEnd!) > 0 { sidecarEnd = time }
    }
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
    private(set) var levels: AudioLevelMeter?

    init(sources: [CaptureAudioSource], movieInputs: [CaptureAudioSource: AVAssetWriterInput], sidecarDirectory: URL?) {
        self.sources = sources
        super.init()
        if CommandLine.arguments.contains("--levels") { levels = AudioLevelMeter(queue: queue, micID: argValue("--mic-device")) }
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
        levels?.append(sampleBuffer, source: source, muted: track.muted)
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

    /// Movie positions are relative to `origin`; a sidecar's duration and mute spans use its own sample timeline.
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
                    row["durationMs"] = track.fileTimeline.durationMs
                    row["mutedSpans"] = track.fileTimeline.mutedSpans
                    row["lostSpans"] = track.lostSpans
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
