import CoreMedia
import CoreVideo
import Foundation

/// How a `CameraFrameSource` runs.
public enum CameraCaptureMode: Equatable, Sendable {
    /// The session is stopped and the camera light is off.
    case off
    /// The session runs and delivers at most `fps` frames per second.
    case continuous(fps: Double)
    /// Every `every` seconds the session starts, discards warm-up frames until the exposure settles,
    /// delivers `frames` frames about 0.2 s apart, and stops again. The light is off between bursts.
    case interval(every: TimeInterval, frames: Int)

    public var usesCamera: Bool { self != .off }
}

/// One camera frame on its way to a pose engine. The pixel buffer is only valid during the callback;
/// an engine that keeps it past the callback must retain it (Swift does) and expect the camera to
/// recycle the pool if it holds too many.
public struct CameraFrame: @unchecked Sendable {
    public var pixelBuffer: CVPixelBuffer
    /// Seconds on the uptime clock (`ProcessInfo.systemUptime`) when the frame reached the delegate.
    public var time: TimeInterval
    /// Mean brightness 0...1 from a sparse grid of pixels; nil when the format is not read.
    public var meanLuma: Double?
    /// True for the frames of an interval burst.
    public var isBurst: Bool

    public init(pixelBuffer: CVPixelBuffer, time: TimeInterval, meanLuma: Double?, isBurst: Bool = false) {
        self.pixelBuffer = pixelBuffer
        self.time = time
        self.meanLuma = meanLuma
        self.isBurst = isBurst
    }

    /// A frame darker than this is "unknown" rather than "away" (Dorso #67: low light read as away).
    public static let lowLightLuma = 0.08

    public var isLowLight: Bool { (meanLuma ?? 1) < Self.lowLightLuma }

    public var imageAspect: Double {
        let width = Double(CVPixelBufferGetWidth(pixelBuffer))
        let height = Double(CVPixelBufferGetHeight(pixelBuffer))
        return height > 0 ? width / height : 4.0 / 3.0
    }
}

/// Decides when a cold camera's exposure has settled. Pure: frames in, verdict out.
///
/// It waits at least `minimumWait` seconds and `minimumFrames` frames (SpineSpy waits 0.5 s and drops
/// 5 frames), then until the device stops adjusting exposure and two frames in a row agree on brightness
/// within `lumaTolerance`, but never longer than `maximumWait` (1.5 s cap, PoseEngines research).
public struct CameraWarmup: Equatable, Sendable {
    public var minimumWait: TimeInterval
    public var minimumFrames: Int
    public var maximumWait: TimeInterval
    public var lumaTolerance: Double

    private var start: TimeInterval?
    private var frames = 0
    private var lastLuma: Double?

    public init(minimumWait: TimeInterval = 0.5, minimumFrames: Int = 5, maximumWait: TimeInterval = 1.5,
                lumaTolerance: Double = 0.02) {
        self.minimumWait = minimumWait
        self.minimumFrames = minimumFrames
        self.maximumWait = maximumWait
        self.lumaTolerance = lumaTolerance
    }

    /// Feeds one frame; true once the exposure counts as settled (this frame is usable).
    public mutating func settled(at time: TimeInterval, luma: Double?, adjustingExposure: Bool) -> Bool {
        if start == nil { start = time }
        frames += 1
        let elapsed = time - (start ?? time)
        defer { lastLuma = luma }
        if elapsed >= maximumWait { return true }
        guard elapsed >= minimumWait, frames > minimumFrames, !adjustingExposure else { return false }
        guard let luma, let lastLuma else { return luma == nil }
        return abs(luma - lastLuma) <= lumaTolerance
    }

    public mutating func reset() {
        start = nil
        frames = 0
        lastLuma = nil
    }
}

/// Drops frames above a rate. Pure, so the throttle a camera applies in software is testable.
///
/// It keeps a deadline that advances by one interval per kept frame, so the long-run rate is exact, and
/// admits a frame up to 10% of an interval early so timestamp jitter never costs a whole frame.
public struct FrameThrottle: Equatable, Sendable {
    public var interval: TimeInterval
    private var next: TimeInterval?

    public init(fps: Double) {
        interval = fps > 0 ? 1 / fps : .infinity
    }

    /// True when a frame at `time` should be delivered. A rate of zero or less admits nothing.
    public mutating func admit(_ time: TimeInterval) -> Bool {
        guard interval.isFinite else { return false }
        if let next, time < next - interval * 0.1 { return false }
        let due = next ?? time
        // After a gap (the camera paused, frames stopped) start again from this frame.
        next = time - due > interval ? time + interval : due + interval
        return true
    }

    public mutating func reset() { next = nil }
}

enum PixelLuma {
    /// Mean brightness from a sparse 16 by 12 grid: the Y plane of a bi-planar YUV buffer, or a weighted
    /// sum of BGRA. About 200 reads per frame.
    static func mean(_ buffer: CVPixelBuffer) -> Double? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let format = CVPixelBufferGetPixelFormatType(buffer)
        let columns = 16, rows = 12
        switch format {
        case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
            guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
            let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
            let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
            guard width > 0, height > 0 else { return nil }
            let bytes = base.assumingMemoryBound(to: UInt8.self)
            var sum = 0
            for row in 0..<rows {
                let y = (row * 2 + 1) * height / (rows * 2)
                for column in 0..<columns {
                    let x = (column * 2 + 1) * width / (columns * 2)
                    sum += Int(bytes[y * stride + x])
                }
            }
            let mean = Double(sum) / Double(rows * columns) / 255
            return format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ? min(max((mean - 16.0 / 255) * 255 / 219, 0), 1) : mean
        case kCVPixelFormatType_32BGRA:
            guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
            let width = CVPixelBufferGetWidth(buffer)
            let height = CVPixelBufferGetHeight(buffer)
            let stride = CVPixelBufferGetBytesPerRow(buffer)
            guard width > 0, height > 0 else { return nil }
            let bytes = base.assumingMemoryBound(to: UInt8.self)
            var sum = 0.0
            for row in 0..<rows {
                let y = (row * 2 + 1) * height / (rows * 2)
                for column in 0..<columns {
                    let x = (column * 2 + 1) * width / (columns * 2)
                    let pixel = bytes + y * stride + x * 4
                    sum += 0.114 * Double(pixel[0]) + 0.587 * Double(pixel[1]) + 0.299 * Double(pixel[2])
                }
            }
            return sum / Double(rows * columns) / 255
        default:
            return nil
        }
    }
}
