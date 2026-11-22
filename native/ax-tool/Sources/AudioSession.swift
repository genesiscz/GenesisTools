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

/// Event rows leave the process on their own serial queue, so a parent that stops reading never holds the sample
/// queue, and with it pause, mute and finish. A droppable row (a level reading) waits only while fewer than
/// `droppableLimit` others do; beyond that the oldest waiting one goes, and the next written row is preceded by a
/// warning that counts them. Segment rows and warnings are never dropped: `drain` waits for them with a deadline.
/// They wait only while fewer than `reliableLimit` others do; the row beyond that is refused and `overflowed` is
/// called once, so a reader that stopped for good fails the capture instead of growing the backlog forever.
/// Waiting rows are keyed by send order, so writing the next row and dropping the oldest level row cost the same
/// at any backlog, under the lock the sample queue shares.
final class AudioRowOutput {
    private struct Row {
        let droppable: Bool
        let write: () -> Void
    }

    private let queue = DispatchQueue(label: "ax-tool.audio-session.output", qos: .utility)
    private let lock = NSLock()
    private let unwritten = DispatchGroup()
    private var rows: [Int: Row] = [:]
    private var nextSequence = 0
    private var nextToWrite = 0
    /// The send order of each waiting droppable row, oldest first from `droppableHead`.
    private var droppableSequences: [Int] = []
    private var droppableHead = 0
    private var waitingReliable = 0
    private var dropped = 0
    private var refused = false
    private var pumping = false
    private let droppableLimit: Int
    private let reliableLimit: Int
    private let warnDropped: (Int) -> Void
    /// Called once, off the lock, with the limit, when a reliable row is refused. Set it before the first `send`.
    var overflowed: ((Int) -> Void)?

    init(droppableLimit: Int = 32, reliableLimit: Int = 4096, warnDropped: @escaping (Int) -> Void) {
        self.droppableLimit = max(1, droppableLimit)
        self.reliableLimit = max(1, reliableLimit)
        self.warnDropped = warnDropped
    }

    private var waitingDroppable: Int { droppableSequences.count - droppableHead }

    /// Called under `lock`: forgets the oldest waiting droppable row's place and answers its send order.
    private func takeOldestDroppable() -> Int {
        let sequence = droppableSequences[droppableHead]
        droppableHead += 1
        if droppableHead >= 64, droppableHead * 2 >= droppableSequences.count {
            droppableSequences.removeFirst(droppableHead)
            droppableHead = 0
        }
        return sequence
    }

    /// Never blocks on the reader: the write runs later, on the output queue.
    func send(droppable: Bool, _ write: @escaping () -> Void) {
        lock.lock()
        if droppable, waitingDroppable >= droppableLimit {
            rows[takeOldestDroppable()] = nil
            dropped += 1
            unwritten.leave()
        }
        if !droppable, waitingReliable >= reliableLimit {
            let first = !refused
            refused = true
            lock.unlock()
            if first { overflowed?(reliableLimit) }
            return
        }
        unwritten.enter()
        rows[nextSequence] = Row(droppable: droppable, write: write)
        if droppable {
            droppableSequences.append(nextSequence)
        } else {
            waitingReliable += 1
        }
        nextSequence += 1
        let start = !pumping
        pumping = true
        lock.unlock()
        if start { queue.async { [self] in pump() } }
    }

    private func pump() {
        while true {
            lock.lock()
            var next: Row?
            // Skips the places of dropped rows; each is skipped once.
            while next == nil, nextToWrite < nextSequence {
                next = rows.removeValue(forKey: nextToWrite)
                nextToWrite += 1
            }
            guard let row = next else {
                pumping = false
                lock.unlock()
                return
            }
            if row.droppable {
                _ = takeOldestDroppable()
            } else {
                waitingReliable -= 1
            }
            let lost = dropped
            dropped = 0
            lock.unlock()
            if lost > 0 { warnDropped(lost) }
            row.write()
            unwritten.leave()
        }
    }

    /// True when every row sent so far was written before the deadline, and none was refused.
    func drain(timeout: TimeInterval) -> Bool {
        guard unwritten.wait(timeout: .now() + timeout) == .success else { return false }
        lock.lock()
        defer { lock.unlock() }
        return !refused
    }
}

/// Audio is delivered on one serial queue. Retired writers finish on another queue, so rotation never
/// holds up the next segment's samples. Capture timestamps, including missing samples, rotate files.
/// Rows go out through `output`, never from the sample queue itself.
@available(macOS 13.0, *)
final class SegmentedAudio: NSObject, SCStreamOutput {
    let queue = DispatchQueue(label: "ax-tool.audio-session.samples", qos: .userInitiated)
    private let finishing = DispatchGroup()
    let output: AudioRowOutput
    private let directory: URL
    private let segmentSeconds: Double
    private let clock: () -> (host: CMTime, wall: Date)
    private var tracks: [CaptureAudioSource: AudioTrack] = [:]
    private var announced: Set<CaptureAudioSource> = []
    private var encoderPriming: [CaptureAudioSource: UInt32] = [:]
    private var sequence: [CaptureAudioSource: Int] = [:]
    private var retiredEnd: [CaptureAudioSource: CMTime] = [:]
    private var muted: [CaptureAudioSource: Bool] = [:]
    /// The sources whose first buffer arrived; each reports its `timing` once.
    private var heard: Set<CaptureAudioSource> = []
    private var paused = false
    private var closed = false
    private let monitorOnly: Bool
    private(set) var levels: AudioLevelMeter?
    var failed: ((String) -> Void)?
    private let emit: ((Data) -> Void)?
    var rangeCopy: AudioRangeCopy = copyAudioRange

    init(directory: URL, seconds: Double, emit: ((Data) -> Void)? = nil,
         muted: [CaptureAudioSource] = [], paused: Bool = false, monitorOnly: Bool = false, metering: Bool = false,
         micID: String? = nil, clock: (() -> (host: CMTime, wall: Date))? = nil) {
        self.directory = directory
        self.monitorOnly = monitorOnly
        self.emit = emit
        output = AudioRowOutput { [emit] count in
            let row: [String: Any] = ["event": "warning", "droppedRows": count,
                "message": "dropped \(count) audio level rows while the reader was not reading"]
            if let emit, var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
                data.append(0x0a)
                emit(data)
            } else if emit == nil {
                CaptureEvents.emit(row)
            }
        }
        segmentSeconds = seconds
        self.muted = Dictionary(uniqueKeysWithValues: muted.map { ($0, true) })
        self.paused = paused
        self.clock = clock ?? { (CMClockGetTime(CMClockGetHostTimeClock()), Date()) }
        super.init()
        output.overflowed = { [weak self] limit in
            guard let self else { return }
            queue.async {
                self.fail("the reader stopped reading audio rows: \(limit) segment rows and warnings are waiting")
            }
        }
        if metering {
            levels = AudioLevelMeter(queue: queue, micID: micID) { [weak self] row in
                self?.send(row, droppable: true, event: true)
            }
        }
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
        if heard.insert(source).inserted {
            emitStartTiming("first-buffer-\(source.rawValue)")
        }
        levels?.append(buffer, source: source, muted: muted[source] ?? false)
        if monitorOnly { return }
        let count = CMSampleBufferGetNumSamples(buffer)
        var offset = 0
        if let end = retiredEnd[source] {
            let overlap = CMTimeGetSeconds(CMTimeSubtract(end, CMSampleBufferGetPresentationTimeStamp(buffer)))
            // Trim to the retired file's last sample, so no sample is in two files.
            offset = min(count, max(0, Int((overlap * rate).rounded())))
        }
        while offset < count && !closed {
            let time = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(buffer), CMTime(seconds: Double(offset) / rate, preferredTimescale: 1_000_000_000))
            if let open = tracks[source], rotatesBeforeGap(open, source: source, at: time) {
                continue
            }
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
                    send(["event": "warning", "message": "could not trim \(source.rawValue) segment overlap: range copy status \(copy.status)"], event: true)
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
                send(row)
            }
            let end = CMTimeAdd(time, CMTime(seconds: Double(length) / rate, preferredTimescale: 1_000_000_000))
            if track.end == nil || CMTimeCompare(end, track.end!) > 0 { track.end = end }
            offset += length
            if CMTimeGetSeconds(CMTimeSubtract(track.end ?? end, track.first ?? time)) >= segmentSeconds - 0.5 / rate {
                retire(source)
            }
        }
    }

    /// A gap that reaches the segment's end, or is longer than one callback may fill, ends the open file first:
    /// it gets silence up to its boundary when that fits the fill limit (encoded while it finishes, off this
    /// queue), and the resumed buffer opens the next file at its own time. Anything longer is the time between
    /// the two files. Answers whether the file was retired.
    private func rotatesBeforeGap(_ track: AudioTrack, source: CaptureAudioSource, at time: CMTime) -> Bool {
        guard let next = track.sidecarNextTime, let first = track.first else { return false }
        let gap = CMTimeGetSeconds(CMTimeSubtract(time, next))
        let boundary = CMTimeAdd(first, CMTime(seconds: segmentSeconds, preferredTimescale: 1_000_000_000))
        let crosses = CMTimeCompare(time, boundary) >= 0
        guard gap > 0.005, crosses || gap > AudioTrack.fillSecondsPerAppend else { return false }
        let stop = crosses ? boundary : time
        if CMTimeGetSeconds(CMTimeSubtract(stop, next)) <= AudioTrack.fillSecondsPerAppend {
            track.extendSidecar(to: stop)
            if track.end == nil || CMTimeCompare(stop, track.end!) > 0 { track.end = stop }
        }
        retire(source)
        return true
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
            send(row)
        }
    }

    /// Segment rows go to stdout and `event` rows to the control events; a test's `emit` receives both.
    private func send(_ row: [String: Any], droppable: Bool = false, event: Bool = false) {
        if event, emit == nil {
            output.send(droppable: droppable) { CaptureEvents.emit(row) }
            return
        }
        do {
            var data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            data.append(0x0a)
            if let emit {
                output.send(droppable: droppable) { emit(data) }
            } else {
                output.send(droppable: droppable) { FileHandle.standardOutput.write(data) }
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
        let output = self.output
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .utility).async {
                if finishing.wait(timeout: .now() + 15) == .timedOut {
                    continuation.resume(throwing: NSError(domain: "ax-tool", code: 75,
                        userInfo: [NSLocalizedDescriptionKey: "audio segments did not finish within 15s"]))
                } else if !output.drain(timeout: 5) {
                    // The last segment rows sit behind a reader that stopped reading; exiting now would lose them.
                    continuation.resume(throwing: NSError(domain: "ax-tool", code: 75,
                        userInfo: [NSLocalizedDescriptionKey: "audio segment rows were not read within 5s"]))
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
    var independent: IndependentAudio?
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
            if let independent {
                do {
                    try independent.switchMicrophone(id)
                    audio.queue.async { [audio] in audio.levels?.micID = id }
                    CaptureEvents.emit(["event": "settings", "micDevice": id])
                } catch { CaptureEvents.error("failed", error.localizedDescription) }
                return
            }
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
                    audio.queue.async { [audio] in audio.levels?.micID = id }
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
            independent?.stop()
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

/// Milliseconds since this process was spawned. The exec into the private recorder copy keeps the pid and its start
/// time, so the first step's number includes the copy. Nil when the kernel does not answer.
func millisecondsSinceSpawn() -> Int? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
    return Int(((Date().timeIntervalSince1970 - started) * 1000).rounded())
}

/// One `timing` event on stderr: how long after its spawn the sound session reached `step`. The supervisor logs them,
/// so a slow microphone restart says which step took the time (spawn and copy, the content listing, the stream start
/// with the device open, or the first buffer).
func emitStartTiming(_ step: String) {
    CaptureEvents.emit(["event": "timing", "step": step, "sinceSpawnMs": millisecondsSinceSpawn() ?? NSNull()])
}

func cmdAudioRecord() {
    defaultErrorCode = "failed"
    guard #available(macOS 13.0, *) else { errorExit("audio-record needs macOS 13 or newer") }
    CaptureEvents.enabled = true
    let withoutScreen = CommandLine.arguments.contains("--without-screen")
    // `--prefer-tap`: the Core Audio tap first, as `--without-screen` records, and the display stream when the tap
    // cannot start. An open display stream slows the screen while a never-capture window is on its display
    // (`NeverCaptureRule`); the tap opens no stream.
    let preferTap = !withoutScreen && CommandLine.arguments.contains("--prefer-tap")
    if !withoutScreen {
        let warnings = runFromPrivateRecorderCopy()
        for warning in warnings { CaptureEvents.emit(["event": "warning", "message": warning]) }
        requireScreenRecording()
    }
    emitStartTiming("launched")
    let monitorOnly = CommandLine.arguments.contains("--monitor")
    guard monitorOnly || argValue("--out") != nil else { errorExit("audio-record needs --out", code: "invalid-argument") }
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
    // The tap path opens the microphone by itself, so it takes the sources as asked.
    let asked = sources
    if !withoutScreen && sources.contains(.mic) {
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
    let directory = argValue("--out").map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
    let micID = argValue("--mic-device")
    do {
        if !monitorOnly { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        let configuration = SCStreamConfiguration()
        let audio = SegmentedAudio(directory: directory, seconds: seconds, muted: muted, paused: paused,
                                   monitorOnly: monitorOnly, metering: monitorOnly || CommandLine.arguments.contains("--levels"),
                                   micID: micID)
        var streamReason: String?
        if withoutScreen || preferTap {
            let inputs = IndependentAudio(audio: audio)
            var started: [CaptureAudioSource] = []
            var failures: [String] = []
            // The system sound first: when its tap cannot start under --prefer-tap, nothing else has started yet.
            for source in asked.sorted(by: { first, _ in first == .system }) {
                do {
                    try inputs.start(source, micDevice: micID)
                    started.append(source)
                } catch {
                    failures.append("\(source.rawValue) audio omitted: \(error.localizedDescription)")
                    if preferTap && source == .system { break }
                }
            }
            let tapRecords = !started.isEmpty && (!asked.contains(.system) || started.contains(.system))
            if withoutScreen || tapRecords {
                for reason in failures { CaptureEvents.emit(["event": "warning", "message": reason]) }
                guard !started.isEmpty else { errorExit(failures.joined(separator: " "), code: "no-permission") }
                emitStartTiming("capture-started")
                if preferTap { CaptureEvents.emit(["event": "audio-path", "path": "tap"]) }
                let host = AudioSessionHost(audio: audio, sources: started, configuration: configuration, muted: muted, paused: paused)
                host.independent = inputs
                host.controls()
                host.state()
                dispatchMain()
            }
            inputs.stop()
            streamReason = failures.first ?? "the tap opened no source"
            CaptureEvents.emit(["event": "warning",
                                "message": "the system sound tap did not start (\(streamReason ?? "")); the display stream records the sound"])
        }
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.capturesAudio = sources.contains(.system)
        configuration.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) {
            configuration.captureMicrophone = sources.contains(.mic)
            configuration.microphoneCaptureDeviceID = micID
        }
        let content = try awaitResult { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        emitStartTiming("content-listed")
        guard let display = content.displays.first else { errorExit("audio-record found no shareable display") }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let host = AudioSessionHost(audio: audio, sources: sources, configuration: configuration, muted: muted, paused: paused)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: host)
        host.stream = stream
        if sources.contains(.system) { try stream.addStreamOutput(audio, type: .audio, sampleHandlerQueue: audio.queue) }
        if sources.contains(.mic), #available(macOS 15.0, *) {
            try stream.addStreamOutput(audio, type: .microphone, sampleHandlerQueue: audio.queue)
        }
        try awaitResult { try await stream.startCapture() }
        emitStartTiming("capture-started")
        if preferTap {
            CaptureEvents.emit(["event": "audio-path", "path": "stream", "reason": streamReason ?? ""])
        }
        host.controls()
        host.state()
        dispatchMain()
    } catch {
        errorExit("audio-record never started: \(error.localizedDescription)")
    }
}
