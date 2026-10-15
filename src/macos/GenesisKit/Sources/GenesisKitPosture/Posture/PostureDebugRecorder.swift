import AVFoundation
import Foundation
import GenesisKit

/// What a finished debug recording left in its folder.
public struct PostureDebugRecording: Sendable {
    public var folder: URL
    /// `movie.mp4`: every analyzed frame, H.264, at its capture time. Nil when no frame arrived or the writer failed.
    public var movie: URL?
    /// `log.ndjson`: a `start` line (baseline, scorer), then one `frame` line per analyzed frame.
    public var log: URL
    public var frames: Int
    public var duration: TimeInterval
    public var error: String?

    public init(folder: URL, movie: URL?, log: URL, frames: Int, duration: TimeInterval, error: String? = nil) {
        self.folder = folder
        self.movie = movie
        self.log = log
        self.frames = frames
        self.duration = duration
        self.error = error
    }
}

/// Records what the monitor sees, for a bug report: the analyzed camera frames as a movie, and per frame
/// the sample, the measures, the score with each signal and the state, as NDJSON. Frames arrive on the
/// camera's serial delivery queue; the writer finishes on its own.
final class PostureDebugRecorder: @unchecked Sendable {
    let folder: URL
    let maxDuration: TimeInterval
    private let completion: @Sendable (PostureDebugRecording) -> Void
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var log: FileHandle?
    private var startTime: TimeInterval?
    private var lastTime: TimeInterval = 0
    private var frames = 0
    private var finished = false
    private var writerError: String?
    /// The first problem with `log.ndjson`: the folder or the file could not be made or opened, or a line could not
    /// be written. Reported in the result, so a recording never claims a log it did not write (review of #514).
    private var logError: String?
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    var movieURL: URL { folder.appendingPathComponent("movie.mp4") }
    var logURL: URL { folder.appendingPathComponent("log.ndjson") }

    init(folder: URL, maxDuration: TimeInterval, completion: @escaping @Sendable (PostureDebugRecording) -> Void) {
        self.folder = folder
        self.maxDuration = maxDuration
        self.completion = completion
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: logURL.path, contents: nil) else {
                throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: logURL.path])
            }
            log = try FileHandle(forWritingTo: logURL)
        } catch {
            logError = "the log could not be created: \(error.localizedDescription)"
        }
    }

    /// The `start` line: what every frame is judged against.
    func writeStart(baseline: PostureBaseline?, scorer: PostureScorer, engine: PoseEngineKind?) {
        var line: [String: Any] = [
            "type": "start",
            "deadZone": scorer.deadZone.title,
            "sensitivity": scorer.sensitivity.title,
            "enabled": scorer.enabled.map(\.rawValue).sorted(),
            "forwardHeadWithoutShoulders": scorer.forwardHeadWithoutShoulders?.rawValue ?? "faceEngine",
        ]
        if let engine { line["engine"] = engine.rawValue }
        if let baseline, let data = try? encoder.encode(baseline), let object = try? JSONSerialization.jsonObject(with: data) {
            line["baseline"] = object
        }
        write(line)
    }

    /// Adds one analyzed frame. Returns false once the recording is over (time is up or it was stopped), so
    /// the caller drops it.
    @discardableResult
    func append(frame: CameraFrame, sample: PoseSample?, score: PostureScore?, state: PostureState) -> Bool {
        let shouldFinish: Bool? = lock.withLock {
            if finished { return nil }
            if startTime == nil { startWriter(frame) }
            let start = startTime ?? frame.time
            appendFrame(frame)
            frames += 1
            lastTime = frame.time
            var line: [String: Any] = [
                "type": "frame", "index": frames, "t": (frame.time - start).rounded(toPlaces: 3),
                "state": Self.describe(state), "lowLight": frame.isLowLight,
            ]
            if let luma = frame.meanLuma { line["luma"] = luma.rounded(toPlaces: 3) }
            if let sample, let data = try? encoder.encode(sample), let object = try? JSONSerialization.jsonObject(with: data) {
                line["sample"] = object
                line["metrics"] = Dictionary(uniqueKeysWithValues: PostureMetrics(sample: sample).values.map {
                    ($0.key.rawValue, $0.value.rounded(toPlaces: 4))
                })
            }
            if let score { line["score"] = Self.describe(score) }
            writeLocked(line)
            return frame.time - start >= maxDuration
        }
        guard let shouldFinish else { return false }
        if shouldFinish { stop() }
        return !shouldFinish
    }

    /// Ends the recording now; the completion runs once the movie is written.
    func stop() {
        let parts: (AVAssetWriter?, AVAssetWriterInput?)? = lock.withLock {
            guard !finished else { return nil }
            finished = true
            try? log?.close()
            log = nil
            return (self.writer, self.input)
        }
        guard let parts else { return }
        guard let writer = parts.0, let input = parts.1, writer.status == .writing else {
            report(movieWritten: false)
            return
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(seconds: lastTime, preferredTimescale: 600))
        writer.finishWriting { [self] in
            if writer.status != .completed {
                lock.withLock { writerError = writer.error?.localizedDescription ?? "the movie could not be written" }
            }
            report(movieWritten: writer.status == .completed)
        }
    }

    private func report(movieWritten: Bool) {
        let result: PostureDebugRecording = lock.withLock {
            PostureDebugRecording(folder: folder, movie: movieWritten ? movieURL : nil, log: logURL, frames: frames,
                                  duration: startTime.map { lastTime - $0 } ?? 0,
                                  error: [writerError, logError].compactMap { $0 }.joined(separator: "; ").nilIfEmpty)
        }
        completion(result)
    }

    // MARK: - Writer (under the lock)

    private func startWriter(_ frame: CameraFrame) {
        startTime = frame.time
        let width = CVPixelBufferGetWidth(frame.pixelBuffer) & ~1
        let height = CVPixelBufferGetHeight(frame.pixelBuffer) & ~1
        do {
            let writer = try AVAssetWriter(outputURL: movieURL, fileType: .mp4)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            ])
            input.expectsMediaDataInRealTime = true
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
            guard writer.canAdd(input) else { throw NSError(domain: "PostureDebugRecorder", code: 1) }
            writer.add(input)
            guard writer.startWriting() else { throw writer.error ?? NSError(domain: "PostureDebugRecorder", code: 2) }
            writer.startSession(atSourceTime: CMTime(seconds: frame.time, preferredTimescale: 600))
            self.writer = writer
            self.input = input
            self.adaptor = adaptor
        } catch {
            writerError = error.localizedDescription
        }
    }

    private func appendFrame(_ frame: CameraFrame) {
        guard let adaptor, let input, input.isReadyForMoreMediaData, frame.time >= lastTime else { return }
        if !adaptor.append(frame.pixelBuffer, withPresentationTime: CMTime(seconds: frame.time, preferredTimescale: 600)),
           writerError == nil {
            writerError = writer?.error?.localizedDescription ?? "a frame could not be added"
        }
    }

    private func write(_ line: [String: Any]) {
        lock.withLock { writeLocked(line) }
    }

    private func writeLocked(_ line: [String: Any]) {
        guard let log, let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        do {
            try log.write(contentsOf: data + Data([0x0A]))
        } catch {
            if logError == nil { logError = "a log line could not be written: \(error.localizedDescription)" }
        }
    }

    // MARK: - Descriptions

    static func describe(_ state: PostureState) -> String {
        switch state {
        case .disabled: "disabled"
        case .needsCalibration: "needsCalibration"
        case .paused: "paused"
        case .cameraUnavailable: "cameraUnavailable"
        case .away: "away"
        case .monitoring: "monitoring"
        case .slouching: "slouching"
        case .recovery: "recovery"
        }
    }

    static func describe(_ score: PostureScore) -> [String: Any] {
        [
            "isBad": score.isBad, "isClear": score.isClear, "severity": score.severity.rounded(toPlaces: 4),
            "worst": score.worst?.rawValue ?? NSNull(), "unjudged": score.unjudged.map(\.rawValue).sorted(),
            "signals": score.signals.map { signal -> [String: Any] in
                [
                    "kind": signal.kind.rawValue, "measure": signal.measure.rawValue,
                    "deviation": signal.deviation.rounded(toPlaces: 4), "enter": signal.enterThreshold.rounded(toPlaces: 4),
                    "exit": signal.exitThreshold.rounded(toPlaces: 4), "severity": signal.severity.rounded(toPlaces: 4),
                    "bad": signal.isBad,
                ]
            },
        ]
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (self * scale).rounded() / scale
    }
}
