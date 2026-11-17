import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit
import SnapshotSupport

func sessionEncoderPrimingFrames(settings: [String: Any]) -> UInt32? {
    guard let output = AVAudioFormat(settings: settings),
          let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: output.sampleRate,
                                    channels: output.channelCount, interleaved: false),
          let converter = AVAudioConverter(from: input, to: output) else { return nil }
    if let bitRate = settings[AVEncoderBitRateKey] as? Int { converter.bitRate = bitRate }
    return converter.primeInfo.leadingFrames
}

/// Audio is delivered on one serial queue. Retired writers finish on another queue, so rotation never
/// holds up the next segment's samples. Capture timestamps, including missing samples, rotate files.
@available(macOS 13.0, *)
final class SegmentedAudio: NSObject, SCStreamOutput {
    let queue = DispatchQueue(label: "ax-tool.audio-session.samples", qos: .userInitiated)
    private let finishing = DispatchGroup()
    private let outputLock = NSLock()
    private let directory: URL
    private let segmentSeconds: Double
    private let clock: () -> (host: CMTime, wall: Date)
    private var tracks: [CaptureAudioSource: AudioTrack] = [:]
    private var announced: Set<CaptureAudioSource> = []
    private var encoderPriming: [CaptureAudioSource: UInt32] = [:]
    private var sequence: [CaptureAudioSource: Int] = [:]
    private var retiredEnd: [CaptureAudioSource: CMTime] = [:]
    private var muted: [CaptureAudioSource: Bool] = [:]
    private var paused = false
    private var closed = false
    var failed: ((String) -> Void)?
    private let emit: ((Data) -> Void)?
    var rangeCopy: AudioRangeCopy = copyAudioRange

    init(directory: URL, seconds: Double, emit: ((Data) -> Void)? = nil,
         muted: [CaptureAudioSource] = [], paused: Bool = false,
         clock: (() -> (host: CMTime, wall: Date))? = nil) {
        self.directory = directory
        self.emit = emit
        segmentSeconds = seconds
        self.muted = Dictionary(uniqueKeysWithValues: muted.map { ($0, true) })
        self.paused = paused
        self.clock = clock ?? { (CMClockGetTime(CMClockGetHostTimeClock()), Date()) }
    }

    private func wallTime(_ time: CMTime) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let anchor = clock()
        return formatter.string(from: anchor.wall.addingTimeInterval(CMTimeGetSeconds(CMTimeSubtract(time, anchor.host))))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        let source: CaptureAudioSource
        if type == .audio {
            source = .system
        } else if #available(macOS 15.0, *), type == .microphone {
            source = .mic
        } else {
            return
        }
        append(buffer, source: source)
    }

    /// Called on `queue`; tests supply PCM buffers without constructing a stream or opening a device.
    func append(_ buffer: CMSampleBuffer, source: CaptureAudioSource) {
        guard !closed, !paused, buffer.isValid, CMSampleBufferDataIsReady(buffer),
              let format = CMSampleBufferGetFormatDescription(buffer),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              description.mSampleRate > 0 else { return }
        let rate = description.mSampleRate
        let count = CMSampleBufferGetNumSamples(buffer)
        var offset = 0
        if let end = retiredEnd[source] {
            let overlap = CMTimeGetSeconds(CMTimeSubtract(end, CMSampleBufferGetPresentationTimeStamp(buffer)))
            if overlap > 0.005 { offset = min(count, Int((overlap * rate).rounded())) }
        }
        while offset < count && !closed {
            let time = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(buffer), CMTime(seconds: Double(offset) / rate, preferredTimescale: 1_000_000_000))
            let opening = tracks[source] == nil
            let track: AudioTrack
            if let open = tracks[source] {
                track = open
            } else {
                let number = (sequence[source] ?? 0) + 1
                sequence[source] = number
                let file = "audio-\(String(format: "%06d", number))-\(source.rawValue).m4a"
                track = AudioTrack(source: source, movieInput: nil, sidecarURL: directory.appendingPathComponent(file))
                track.fragmentInterval = CMTime(seconds: 1, preferredTimescale: 48_000)
                track.first = time
                track.zeroAt = wallTime(time)
                tracks[source] = track
            }
            let elapsed = CMTimeGetSeconds(CMTimeSubtract(time, track.first ?? time))
            let remaining = max(1, Int(((segmentSeconds - max(elapsed, track.fileTimeline.seconds)) * rate).rounded()))
            var length = min(count - offset, remaining)
            let part: CMSampleBuffer
            if offset == 0 && length == count {
                // The whole buffer goes through untouched: no copy can fail.
                part = buffer
            } else {
                let copy = rangeCopy(buffer, CFRange(location: offset, length: length))
                if copy.status == noErr, let cut = copy.buffer {
                    part = cut
                } else if offset == 0 {
                    // A buffer that refuses both copies stays whole, at most one buffer beyond the boundary.
                    part = buffer
                    length = count
                } else {
                    if opening && track.fileTimeline.seconds == 0 {
                        tracks[source] = nil
                        sequence[source] = max(0, (sequence[source] ?? 1) - 1)
                    }
                    // An established writer fills the missing time. A still empty track must take its zero
                    // from the next accepted buffer, since no file sample exists at this buffer's time.
                    CaptureEvents.emit(["event": "warning", "message": "could not trim \(source.rawValue) segment overlap: range copy status \(copy.status)"])
                    return
                }
            }
            track.muted = muted[source] ?? false
            let samples: CMSampleBuffer
            if track.muted {
                guard let silent = silentCopy(part) else {
                    fail("could not silence muted \(source.rawValue) audio")
                    return
                }
                samples = silent
            } else {
                samples = part
            }
            track.appendSidecar(samples, at: time)
            guard !track.sidecarFailed else {
                fail(track.failures.last ?? "the \(source.rawValue) writer stopped accepting samples")
                return
            }
            if track.fileTimeline.durationMs > 0, !announced.contains(source), let url = track.sidecarURL {
                announced.insert(source)
                var row: [String: Any] = ["event": "segment-started", "file": url.lastPathComponent,
                    "source": source.rawValue, "zeroAt": track.zeroAt ?? wallTime(track.first ?? time)]
                if encoderPriming[source] == nil {
                    encoderPriming[source] = sessionEncoderPrimingFrames(settings: aacSettings(channels: audioChannelCount(source)))
                }
                if let frames = encoderPriming[source] { row["primingFrames"] = frames }
                writeRow(row)
            }
            let end = CMTimeAdd(time, CMTime(seconds: Double(length) / rate, preferredTimescale: 1_000_000_000))
            if track.end == nil || CMTimeCompare(end, track.end!) > 0 { track.end = end }
            offset += length
            if CMTimeGetSeconds(CMTimeSubtract(track.end ?? end, track.first ?? time)) >= segmentSeconds - 0.5 / rate {
                retire(source)
            }
        }
    }

    private func fail(_ message: String) {
        guard !closed else { return }
        closed = true
        failed?(message)
    }

    private func retire(_ source: CaptureAudioSource) {
        guard let track = tracks.removeValue(forKey: source), let first = track.first else { return }
        announced.remove(source)
        retiredEnd[source] = track.end
        let zeroAt = track.zeroAt ?? wallTime(first)
        finishing.enter()
        DispatchQueue.global(qos: .utility).async { [self] in
            defer { finishing.leave() }
            track.finishSidecar()
            guard track.sidecarWritten, let url = track.sidecarURL else {
                failed?(track.failures.last ?? "the \(source.rawValue) segment could not finish")
                return
            }
            let row: [String: Any] = ["file": url.lastPathComponent, "source": source.rawValue,
                "at": zeroAt, "zeroAt": zeroAt, "durationMs": track.fileTimeline.durationMs,
                "mutedSpans": track.fileTimeline.mutedSpans, "lostSpans": track.lostSpans, "kept": "normal"]
            writeRow(row)
        }
    }

    private func writeRow(_ row: [String: Any]) {
        do {
            var data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            data.append(0x0a)
            outputLock.lock()
            defer { outputLock.unlock() }
            if let emit {
                emit(data)
            } else {
                FileHandle.standardOutput.write(data)
            }
        } catch {
            failed?("could not encode an audio segment: \(error.localizedDescription)")
        }
    }

    func setMuted(_ source: CaptureAudioSource, _ value: Bool) {
        queue.sync { muted[source] = value }
    }

    func setPaused(_ value: Bool) {
        queue.sync {
            guard paused != value else { return }
            paused = value
            if value {
                for source in Array(tracks.keys) { retire(source) }
            }
        }
    }

    func finish() async throws {
        queue.sync {
            closed = true
            for source in Array(tracks.keys) { retire(source) }
        }
        let finishing = self.finishing
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .utility).async {
                if finishing.wait(timeout: .now() + 15) == .timedOut {
                    continuation.resume(throwing: NSError(domain: "ax-tool", code: 75,
                        userInfo: [NSLocalizedDescriptionKey: "audio segments did not finish within 15s"]))
                } else {
                    continuation.resume()
                }
            }
        }
    }
}

@available(macOS 13.0, *)
private final class AudioSessionHost: NSObject, SCStreamDelegate {
    let audio: SegmentedAudio
    let sources: [CaptureAudioSource]
    let configuration: SCStreamConfiguration
    var stream: SCStream?
    private var muted: [String: Bool]
    private var paused: Bool
    private var stopping = false
    private var failed = false
    private var signals: [DispatchSourceSignal] = []

    init(audio: SegmentedAudio, sources: [CaptureAudioSource], configuration: SCStreamConfiguration,
         muted: [CaptureAudioSource], paused: Bool) {
        self.audio = audio
        self.sources = sources
        self.configuration = configuration
        self.muted = ["mic": muted.contains(.mic), "system": muted.contains(.system)]
        self.paused = paused
        super.init()
        audio.failed = { [weak self] message in
            DispatchQueue.main.async {
                CaptureEvents.error("failed", message)
                self?.stop(failed: true)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [self] in
            CaptureEvents.error("failed", "audio stream ended: \(error.localizedDescription)")
            stop(failed: true)
        }
    }

    func state() {
        CaptureEvents.emit(["event": "state", "state": paused ? "paused" : "recording",
                            "sources": sources.map(\.rawValue), "muted": muted])
    }

    func handle(_ command: CaptureCommand) {
        guard !stopping else { return }
        switch command {
        case .stop:
            stop()
        case .pause, .resume:
            paused = command == .pause
            audio.setPaused(paused)
            state()
        case .mute(let source), .unmute(let source):
            guard sources.contains(source) else {
                CaptureEvents.error("invalid-argument", "\(source.rawValue) audio is not recorded")
                return
            }
            let value: Bool
            if case .mute = command { value = true } else { value = false }
            audio.setMuted(source, value)
            muted[source.rawValue] = value
            state()
        case .setMic(let id):
            guard sources.contains(.mic), #available(macOS 15.0, *), let stream else {
                CaptureEvents.error("unsupported", "this session records no microphone")
                return
            }
            guard audioDevices().contains(where: { $0.uid == id && $0.inputChannels > 0 }) else {
                CaptureEvents.error("device-missing", "no input device \(id)")
                return
            }
            Task { @MainActor in
                let previous = configuration.microphoneCaptureDeviceID
                do {
                    configuration.microphoneCaptureDeviceID = id
                    try await stream.updateConfiguration(configuration)
                    CaptureEvents.emit(["event": "settings", "micDevice": id])
                } catch {
                    configuration.microphoneCaptureDeviceID = previous
                    CaptureEvents.error("failed", "microphone change failed: \(error.localizedDescription)")
                }
            }
        case .status:
            state()
        default:
            CaptureEvents.error("unsupported", "this command applies to frames, not sound")
        }
    }

    func controls() {
        Thread.detachNewThread { [self] in
            while let line = readLine(strippingNewline: true) {
                guard let parsed = parseCaptureCommand(line) else { continue }
                DispatchQueue.main.async { [self] in
                    switch parsed {
                    case .success(let command): handle(command)
                    case .failure(let error): CaptureEvents.error("invalid-argument", error.message)
                    }
                }
            }
            DispatchQueue.main.async { [self] in stop() }
        }
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [self] in stop() }
            source.resume()
            signals.append(source)
        }
    }

    func stop(failed: Bool = false) {
        self.failed = self.failed || failed
        guard !stopping else { return }
        stopping = true
        Task { @MainActor in
            var exitCode: Int32 = 0
            do {
                if let stream { try await stream.stopCapture() }
            } catch {
                CaptureEvents.error("failed", "audio stream could not stop: \(error.localizedDescription)")
                exitCode = 1
            }
            do {
                try await audio.finish()
            } catch {
                CaptureEvents.error("failed", error.localizedDescription)
                exitCode = 1
            }
            exit(self.failed ? 1 : exitCode)
        }
    }
}

func cmdAudioRecord() {
    defaultErrorCode = "failed"
    guard #available(macOS 13.0, *) else { errorExit("audio-record needs macOS 13 or newer") }
    CaptureEvents.enabled = true
    let warnings = runFromPrivateRecorderCopy()
    for warning in warnings { CaptureEvents.emit(["event": "warning", "message": warning]) }
    requireScreenRecording()
    guard let out = argValue("--out") else { errorExit("audio-record needs --out", code: "invalid-argument") }
    let seconds = Double(argValue("--segment-sec") ?? "60") ?? .nan
    guard seconds.isFinite, (1...3600).contains(seconds) else {
        errorExit("--segment-sec must be between 1 and 3600", code: "invalid-argument")
    }
    var sources: [CaptureAudioSource]
    switch parseAudioSources(argValue("--sources") ?? "mic,system") {
    case .success(let parsed): sources = parsed
    case .failure(let error): errorExit(error.message, code: "invalid-argument")
    }
    let muted: [CaptureAudioSource]
    if let value = argValue("--muted") {
        switch parseAudioSources(value) {
        case .success(let parsed): muted = parsed
        case .failure(let error): errorExit(error.message, code: "invalid-argument")
        }
    } else {
        muted = []
    }
    let paused = CommandLine.arguments.contains("--paused")
    if sources.contains(.mic) {
        if #unavailable(macOS 15.0) {
            sources.removeAll { $0 == .mic }
        } else if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            sources.removeAll { $0 == .mic }
        }
        if !sources.contains(.mic) {
            CaptureEvents.emit(["event": "warning", "message": "the microphone is not granted; the recording keeps the system sound only"])
        }
    }
    guard !sources.isEmpty else { errorExit("no requested audio source is available", code: "no-permission") }
    let directory = URL(fileURLWithPath: out)
    do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let configuration = SCStreamConfiguration()
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.capturesAudio = sources.contains(.system)
        configuration.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) {
            configuration.captureMicrophone = sources.contains(.mic)
            configuration.microphoneCaptureDeviceID = argValue("--mic-device")
        }
        let content = try awaitResult { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        guard let display = content.displays.first else { errorExit("audio-record found no shareable display") }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let audio = SegmentedAudio(directory: directory, seconds: seconds, muted: muted, paused: paused)
        let host = AudioSessionHost(audio: audio, sources: sources, configuration: configuration, muted: muted, paused: paused)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: host)
        host.stream = stream
        if sources.contains(.system) { try stream.addStreamOutput(audio, type: .audio, sampleHandlerQueue: audio.queue) }
        if sources.contains(.mic), #available(macOS 15.0, *) {
            try stream.addStreamOutput(audio, type: .microphone, sampleHandlerQueue: audio.queue)
        }
        try awaitResult { try await stream.startCapture() }
        host.controls()
        host.state()
        dispatchMain()
    } catch {
        errorExit("audio-record never started: \(error.localizedDescription)")
    }
}
