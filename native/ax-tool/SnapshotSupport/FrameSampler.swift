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
        guard change >= thresholdPercent, change > 0 || thresholdPercent == 0 else {
            return Decision(keep: false, changePercent: change, reason: "still")
        }
        lastKept = signature
        keptCount += 1
        return Decision(keep: true, changePercent: change, reason: "change")
    }
}
