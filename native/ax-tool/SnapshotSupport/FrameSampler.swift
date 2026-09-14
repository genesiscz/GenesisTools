import Foundation

/// A frame reduced to a coarse grid of BGRA samples. Comparing two of these is the whole
/// change-detection step, and it is cheap enough to run on every captured frame.
public struct FrameSignature: Equatable {
    public let width: Int
    public let height: Int
    public let samples: [UInt8]

    /// `stride` is the sampling step in pixels on both axes; `bytesPerRow` is the buffer's
    /// real row pitch, which is padded on Apple silicon and never equals `width * 4`.
    public init(bgra: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int, stride: Int = 4) {
        let step = max(1, stride)
        let columns = max(1, width / step)
        let rows = max(1, height / step)
        var samples = [UInt8](repeating: 0, count: columns * rows * 3)
        var out = 0
        for row in 0..<rows {
            let line = bgra.advanced(by: row * step * bytesPerRow)
            for column in 0..<columns {
                let pixel = line.advanced(by: column * step * 4)
                samples[out] = pixel.load(as: UInt8.self)
                samples[out + 1] = pixel.load(fromByteOffset: 1, as: UInt8.self)
                samples[out + 2] = pixel.load(fromByteOffset: 2, as: UInt8.self)
                out += 3
            }
        }
        self.width = columns
        self.height = rows
        self.samples = samples
    }

    /// Percentage of sampled pixels whose colour moved by more than `tolerance` on any channel.
    /// Signatures of different sizes count as fully changed.
    public func changePercent(from previous: FrameSignature, tolerance: Int = 32) -> Double {
        guard previous.width == width, previous.height == height, !samples.isEmpty else {
            return 100
        }
        var changed = 0
        let count = samples.count / 3
        for index in 0..<count {
            let base = index * 3
            if abs(Int(samples[base]) - Int(previous.samples[base])) > tolerance
                || abs(Int(samples[base + 1]) - Int(previous.samples[base + 1])) > tolerance
                || abs(Int(samples[base + 2]) - Int(previous.samples[base + 2])) > tolerance {
                changed += 1
            }
        }
        return Double(changed) * 100 / Double(count)
    }
}

/// Which captured frames become kept frames. The first always is; afterwards a frame is kept
/// when it differs from the LAST KEPT frame by at least `thresholdPercent`. Comparing against
/// the last kept frame, not the previous captured one, is what stops a slow fade from being
/// sampled as a hundred identical-looking steps.
public struct KeepPolicy {
    public let thresholdPercent: Double
    public let maxFrames: Int
    private var lastKept: FrameSignature?
    public private(set) var keptCount = 0

    public init(thresholdPercent: Double, maxFrames: Int = 800) {
        self.thresholdPercent = max(0, thresholdPercent)
        self.maxFrames = maxFrames
    }

    public struct Decision: Equatable {
        public let keep: Bool
        public let changePercent: Double
        public let reason: String
    }

    public mutating func consider(_ signature: FrameSignature) -> Decision {
        guard keptCount < maxFrames else {
            return Decision(keep: false, changePercent: 0, reason: "cap")
        }
        guard let previous = lastKept else {
            lastKept = signature
            keptCount = 1
            return Decision(keep: true, changePercent: 100, reason: "first")
        }
        let change = signature.changePercent(from: previous)
        // `change > 0` is what makes threshold 0 mean "keep every DIFFERENT frame" rather than
        // "keep every frame": without it an unchanged capture satisfies `0 >= 0` and fills
        // maxFrames with duplicates of one still screen. Above zero the threshold already
        // excludes it.
        guard change >= thresholdPercent, change > 0 else {
            return Decision(keep: false, changePercent: change, reason: "still")
        }
        lastKept = signature
        keptCount += 1
        return Decision(keep: true, changePercent: change, reason: "change")
    }
}

/// Which rate the capture stream should ask for. ScreenCaptureKit caps delivery through
/// `minimumFrameInterval`, so "idle" means asking for fewer frames while nothing moves — the
/// point of `--idle-fps`, which is what a long recording of a mostly-still window costs.
///
/// The switch is asymmetric on purpose. Returning to the active rate takes ONE kept frame,
/// because the frame that ends a still stretch is the interesting one and everything after it
/// must be sampled properly. Dropping to idle takes a run of still frames, so a slow animation
/// whose steps fall under the change threshold is never mistaken for a motionless screen.
public struct FrameRatePolicy {
    public let activeFps: Double
    public let idleFps: Double
    public let stillFramesBeforeIdle: Int
    public private(set) var currentFps: Double
    private var consecutiveStill = 0

    public init(activeFps: Double, idleFps: Double, stillFramesBeforeIdle: Int = 8) {
        self.activeFps = activeFps
        // An idle rate at or above the active one has nothing to save; clamping keeps a
        // mis-set pair from making the recording FASTER when nothing is happening.
        self.idleFps = min(idleFps, activeFps)
        self.stillFramesBeforeIdle = max(1, stillFramesBeforeIdle)
        self.currentFps = activeFps
    }

    /// Feeds one capture decision in. Returns the new rate when it changed, `nil` when it did not.
    public mutating func observe(kept: Bool) -> Double? {
        if kept {
            consecutiveStill = 0
            return switchTo(activeFps)
        }

        consecutiveStill += 1
        guard consecutiveStill >= stillFramesBeforeIdle else { return nil }
        return switchTo(idleFps)
    }

    private mutating func switchTo(_ fps: Double) -> Double? {
        guard fps != currentFps else { return nil }
        currentFps = fps
        return fps
    }
}

/// A frames-per-second figure as a `minimumFrameInterval`. `CMTime(value: 1, timescale: fps)`
/// cannot carry a fractional rate — it rounds `--idle-fps 0.1` to 0 and then clamps to 1 fps,
/// ten times faster than asked — so the interval is expressed in seconds instead.
public func frameInterval(fps: Double) -> (value: Int64, timescale: Int32) {
    let safe = max(0.01, fps)
    let timescale: Int32 = 600
    return (Int64((Double(timescale) / safe).rounded()), timescale)
}
