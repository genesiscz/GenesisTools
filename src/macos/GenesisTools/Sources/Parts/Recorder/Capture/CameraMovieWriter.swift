import AVFoundation
import Foundation
import GenesisKitCamera

/// Writes the camera's frames into one H.264 movie on the wall clock: a frame's time is how long after the first frame
/// it reached the camera, pauses included. The screen movie leaves out its pauses and the gaps between its segments,
/// and only the recording knows them exactly, so it cuts this movie to the screen's spans after both are finished
/// (src/utils/recording-editor/camera.ts `alignCameraMovie`). Frames arrive on the camera's delivery queue; every call
/// holds the lock.
final class CameraMovieWriter: @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    /// The uptime of the first frame: the movie's time 0.
    private var firstUptime: TimeInterval?
    private var lastPts: CMTime = .negativeInfinity
    private var finishing = false
    private(set) var startedAt: Date?
    private(set) var frames = 0
    private(set) var failure: String?

    init(url: URL) {
        self.url = url
    }

    /// The presentation time of a frame that reached the camera at `uptime`. Pure, for tests.
    static func presentationSeconds(uptime: TimeInterval, first: TimeInterval) -> TimeInterval {
        max(0, uptime - first)
    }

    /// The wall time of a moment on the uptime clock, from one reading of both clocks. Pure, for tests.
    static func wallClock(ofUptime uptime: TimeInterval, now: Date, nowUptime: TimeInterval) -> Date {
        now.addingTimeInterval(uptime - nowUptime)
    }

    func append(_ frame: CameraFrame) {
        lock.lock()
        defer { lock.unlock() }
        guard !finishing, failure == nil else { return }
        if writer == nil, !prepare(width: CVPixelBufferGetWidth(frame.pixelBuffer), height: CVPixelBufferGetHeight(frame.pixelBuffer),
                                   uptime: frame.time) {
            return
        }
        guard let input, let adaptor, let first = firstUptime, input.isReadyForMoreMediaData else { return }
        let seconds = Self.presentationSeconds(uptime: frame.time, first: first)
        let pts = CMTime(seconds: seconds, preferredTimescale: 600)
        guard pts > lastPts else { return }
        if adaptor.append(frame.pixelBuffer, withPresentationTime: pts) {
            lastPts = pts
            frames += 1
        } else {
            failure = writer?.error?.localizedDescription ?? "the camera frame was refused"
            HubPerf.log("recorder: camera writer refused a frame: \(failure ?? "")")
        }
    }

    /// Ends the movie; `done` gets the time of its first frame (nil when nothing was written) on the main queue.
    func finish(_ done: @escaping @Sendable (Date?, Int) -> Void) {
        lock.lock()
        finishing = true
        let writer = writer
        let input = input
        let startedAt = startedAt
        let frames = frames
        lock.unlock()
        guard let writer, let input, writer.status == .writing else {
            DispatchQueue.main.async { done(nil, 0) }
            return
        }
        input.markAsFinished()
        writer.finishWriting {
            if writer.status != .completed {
                HubPerf.log("recorder: camera movie did not finish: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")")
            }
            DispatchQueue.main.async { done(writer.status == .completed ? startedAt : nil, frames) }
        }
    }

    private func prepare(width: Int, height: Int, uptime: TimeInterval) -> Bool {
        do {
            try? FileManager.default.removeItem(at: url)
            let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(1_500_000, width * height * 3)],
            ])
            input.expectsMediaDataInRealTime = true
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ])
            guard writer.canAdd(input) else { throw NSError(domain: "camera", code: 1, userInfo: [NSLocalizedDescriptionKey: "the writer takes no video input"]) }
            writer.add(input)
            guard writer.startWriting() else { throw writer.error ?? NSError(domain: "camera", code: 2) }
            writer.startSession(atSourceTime: .zero)
            self.writer = writer
            self.input = input
            self.adaptor = adaptor
            firstUptime = uptime
            // The first frame's own time, not the moment the writer was ready: making the writer takes 140 to 270 ms
            // the first time in a process, and camera.json's startedAt is the movie's time 0.
            startedAt = Self.wallClock(ofUptime: uptime, now: Date(), nowUptime: ProcessInfo.processInfo.systemUptime)
            HubPerf.log("recorder: camera movie \(url.path) \(width)x\(height)")
            return true
        } catch {
            failure = error.localizedDescription
            HubPerf.log("recorder: camera movie could not start: \(error.localizedDescription)")
            return false
        }
    }
}
