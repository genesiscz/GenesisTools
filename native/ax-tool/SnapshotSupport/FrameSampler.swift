import Foundation

/// A frame reduced to a coarse grid of BGRA samples. Comparing two of these is the whole
/// change-detection step, and it is cheap enough to run on every captured frame.
public struct FrameSignature: Equatable {
    public let width: Int
    public let height: Int
    public let samples: [UInt8]
    /// The sampling step and the frame size the samples came from, so a sample grid maps back to output pixels.
    public let stride: Int
    public let pixelWidth: Int
    public let pixelHeight: Int

    /// `stride` is the sampling step in pixels on both axes; `bytesPerRow` is the buffer's
    /// real row pitch, which is padded on Apple silicon and never equals `width * 4`.
    public init(bgra: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int, stride: Int = 4) {
        let step = max(1, stride)
        let columns = max(1, width / step)
        let rows = max(1, height / step)
        var samples = [UInt8](repeating: 0, count: columns * rows * 4)
        var out = 0
        for row in 0..<rows {
            let line = bgra.advanced(by: row * step * bytesPerRow)
            for column in 0..<columns {
                let pixel = line.advanced(by: column * step * 4)
                samples[out] = pixel.load(as: UInt8.self)
                samples[out + 1] = pixel.load(fromByteOffset: 1, as: UInt8.self)
                samples[out + 2] = pixel.load(fromByteOffset: 2, as: UInt8.self)
                samples[out + 3] = pixel.load(fromByteOffset: 3, as: UInt8.self)
                out += 4
            }
        }
        self.width = columns
        self.height = rows
        self.samples = samples
        self.stride = step
        self.pixelWidth = width
        self.pixelHeight = height
    }

    private func sampleChanged(_ index: Int, from previous: FrameSignature, tolerance: Int) -> Bool {
        let base = index * 4
        return abs(Int(samples[base]) - Int(previous.samples[base])) > tolerance
            || abs(Int(samples[base + 1]) - Int(previous.samples[base + 1])) > tolerance
            || abs(Int(samples[base + 2]) - Int(previous.samples[base + 2])) > tolerance
            || abs(Int(samples[base + 3]) - Int(previous.samples[base + 3])) > tolerance
    }

    /// Where the frame changed against `previous`: the changed blocks of `blockSamples`×`blockSamples` samples,
    /// joined into connected regions, overlapping regions merged, then the closest pair merged until at most
    /// `maxBoxes` remain. Boxes are in the frame's own pixels, largest first. Different sizes give one full-frame box.
    public func motionBoxes(from previous: FrameSignature, tolerance: Int = 32, blockSamples: Int = 4,
                            maxBoxes: Int = 8) -> [MotionBox] {
        guard previous.width == width, previous.height == height, !samples.isEmpty else {
            return [MotionBox(x: 0, y: 0, width: pixelWidth, height: pixelHeight)]
        }
        let block = max(1, blockSamples)
        let blockColumns = (width + block - 1) / block
        let blockRows = (height + block - 1) / block
        var changed = [Bool](repeating: false, count: blockColumns * blockRows)
        for row in 0..<height {
            let blockRow = (row / block) * blockColumns
            for column in 0..<width where !changed[blockRow + column / block] {
                if sampleChanged(row * width + column, from: previous, tolerance: tolerance) {
                    changed[blockRow + column / block] = true
                }
            }
        }
        var regions: [BlockRect] = []
        var seen = [Bool](repeating: false, count: changed.count)
        for start in changed.indices where changed[start] && !seen[start] {
            var rect = BlockRect(minX: start % blockColumns, minY: start / blockColumns,
                                 maxX: start % blockColumns, maxY: start / blockColumns)
            var pending = [start]
            seen[start] = true
            while let index = pending.popLast() {
                let x = index % blockColumns
                let y = index / blockColumns
                rect = rect.union(BlockRect(minX: x, minY: y, maxX: x, maxY: y))
                for dy in -1...1 {
                    for dx in -1...1 {
                        let nx = x + dx
                        let ny = y + dy
                        guard nx >= 0, ny >= 0, nx < blockColumns, ny < blockRows else { continue }
                        let next = ny * blockColumns + nx
                        if changed[next] && !seen[next] {
                            seen[next] = true
                            pending.append(next)
                        }
                    }
                }
            }
            regions.append(rect)
        }
        let merged = mergeMotionRegions(regions, maxBoxes: maxBoxes)
        let pixelsPerBlock = block * stride
        return merged.map { rect in
            let x = rect.minX * pixelsPerBlock
            let y = rect.minY * pixelsPerBlock
            return MotionBox(x: x, y: y, width: min(pixelWidth, (rect.maxX + 1) * pixelsPerBlock) - x,
                             height: min(pixelHeight, (rect.maxY + 1) * pixelsPerBlock) - y)
        }
        .sorted { ($0.width * $0.height, $1.y, $1.x) > ($1.width * $1.height, $0.y, $0.x) }
    }

    /// Percentage of sampled pixels whose colour moved by more than `tolerance` on any channel.
    /// Signatures of different sizes count as fully changed.
    public func changePercent(from previous: FrameSignature, tolerance: Int = 32) -> Double {
        guard previous.width == width, previous.height == height, !samples.isEmpty else {
            return 100
        }
        var changed = 0
        let count = samples.count / 4
        for index in 0..<count where sampleChanged(index, from: previous, tolerance: tolerance) {
            changed += 1
        }
        return Double(changed) * 100 / Double(count)
    }
}

/// A changed area of a frame, `x`/`y` from the top-left, in output pixels.
public struct MotionBox: Equatable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var json: [Int] { [x, y, width, height] }
}

/// An inclusive rectangle of block cells.
public struct BlockRect: Equatable {
    public var minX: Int
    public var minY: Int
    public var maxX: Int
    public var maxY: Int

    public init(minX: Int, minY: Int, maxX: Int, maxY: Int) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }

    public var area: Int { (maxX - minX + 1) * (maxY - minY + 1) }

    public func union(_ other: BlockRect) -> BlockRect {
        BlockRect(minX: min(minX, other.minX), minY: min(minY, other.minY),
                  maxX: max(maxX, other.maxX), maxY: max(maxY, other.maxY))
    }

    public func overlaps(_ other: BlockRect) -> Bool {
        minX <= other.maxX && other.minX <= maxX && minY <= other.maxY && other.minY <= maxY
    }
}

/// Merges overlapping rectangles until none overlap, then the pair whose union adds the least area until at most
/// `maxBoxes` remain.
public func mergeMotionRegions(_ regions: [BlockRect], maxBoxes: Int) -> [BlockRect] {
    var rects = regions
    var mergedAny = true
    while mergedAny {
        mergedAny = false
        outer: for i in rects.indices {
            for j in rects.indices where j > i && rects[i].overlaps(rects[j]) {
                rects[i] = rects[i].union(rects[j])
                rects.remove(at: j)
                mergedAny = true
                break outer
            }
        }
    }
    let limit = max(1, maxBoxes)
    while rects.count > limit {
        var best = (i: 0, j: 1, cost: Int.max)
        for i in rects.indices {
            for j in rects.indices where j > i {
                let cost = rects[i].union(rects[j]).area - rects[i].area - rects[j].area
                if cost < best.cost {
                    best = (i, j, cost)
                }
            }
        }
        rects[best.i] = rects[best.i].union(rects[best.j])
        rects.remove(at: best.j)
        // A union can now overlap a third rectangle; fold those in too.
        rects = mergeMotionRegions(rects, maxBoxes: Int.max)
    }

    return rects
}

/// Which captured frames become kept frames. The first always is; afterwards a frame is kept
/// when it differs from the LAST KEPT frame by at least `thresholdPercent`. Comparing against
/// the last kept frame, not the previous captured one, is what stops a slow fade from being
/// sampled as a hundred identical-looking steps.
public struct KeepPolicy {
    public private(set) var thresholdPercent: Double
    public let maxFrames: Int
    /// Bytes of kept frames after which no more are kept (`--max-mb`); nil means no byte cap.
    public let maxBytes: Int?
    private var lastKept: FrameSignature?
    /// The reason of the next first frame: "first" at start, "display-switch" after the recorded display changed.
    private var firstReason = "first"
    public private(set) var keptCount = 0
    public private(set) var bytesWritten = 0

    public init(thresholdPercent: Double, maxFrames: Int = 800, maxBytes: Int? = nil) {
        self.thresholdPercent = max(0, thresholdPercent)
        self.maxFrames = maxFrames
        self.maxBytes = maxBytes
    }

    public struct Decision: Equatable {
        public let keep: Bool
        public let changePercent: Double
        public let reason: String
        /// The frame changed past the threshold against the last kept one: what the frame rate follows. It differs
        /// from `keep` only past the cap, where no still is written but motion is still measured.
        public let moved: Bool
        /// Where a kept "change" frame differs from the last kept one; empty for every other reason.
        public let motionBoxes: [MotionBox]

        public init(keep: Bool, changePercent: Double, reason: String, moved: Bool? = nil, motionBoxes: [MotionBox] = []) {
            self.keep = keep
            self.changePercent = changePercent
            self.reason = reason
            self.moved = moved ?? keep
            self.motionBoxes = motionBoxes
        }
    }

    /// True once either cap is reached: no more frames are kept, motion is still measured.
    public var capReached: Bool { keptCount >= maxFrames || maxBytes.map { bytesWritten >= $0 } == true }

    /// `set-threshold`: later frames are compared with the new cutoff.
    public mutating func setThreshold(_ percent: Double) {
        thresholdPercent = max(0, percent)
    }

    /// Counts the bytes of a frame that reached the disk, for the byte cap.
    public mutating func noteWritten(bytes: Int) {
        bytesWritten += max(0, bytes)
    }

    /// The next frame is kept as the first of a new display, with this reason, and compared from scratch.
    public mutating func restart(reason: String) {
        lastKept = nil
        firstReason = reason
    }

    public mutating func consider(_ signature: FrameSignature) -> Decision {
        guard !capReached else {
            // The cap stops the stills, not the motion check: a recording past it must still return to its active
            // frame rate when the window moves.
            let change = lastKept.map { signature.changePercent(from: $0) } ?? 100
            let moved = change >= thresholdPercent && change > 0
            if moved {
                lastKept = signature
            }

            return Decision(keep: false, changePercent: change, reason: "cap", moved: moved)
        }
        guard let previous = lastKept else {
            lastKept = signature
            keptCount += 1
            return Decision(keep: true, changePercent: 100, reason: firstReason)
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
        return Decision(keep: true, changePercent: change, reason: "change", motionBoxes: signature.motionBoxes(from: previous))
    }

    /// Keeps a frame because nothing changed for the heartbeat interval. Nil past a cap or before any kept frame.
    public mutating func heartbeat(_ signature: FrameSignature) -> Decision? {
        guard !capReached, let previous = lastKept else { return nil }
        let change = signature.changePercent(from: previous)
        lastKept = signature
        keptCount += 1
        return Decision(keep: true, changePercent: change, reason: "heartbeat", moved: false)
    }
}

/// `--heartbeat-sec`: a frame is due when the last kept one is at least the interval old. Zero turns it off.
public struct HeartbeatPolicy {
    public let intervalMs: Int

    public init(seconds: Double) {
        intervalMs = seconds > 0 ? Int((seconds * 1000).rounded()) : 0
    }

    public var enabled: Bool { intervalMs > 0 }

    public func due(nowMs: Int, lastKeptMs: Int?) -> Bool {
        guard enabled, let lastKeptMs else { return false }

        return nowMs - lastKeptMs >= intervalMs
    }
}

/// PNG-only capture encodes synchronously, while a movie may discard stills under backpressure.
public func admitPNG(videoConfigured: Bool, pending: Int, maximum: Int) -> Bool {
    !videoConfigured || pending < maximum
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

    /// Calm time before the idle rate (`--quiet-ms`). When nil, `stillFramesBeforeIdle` frames decide instead.
    public let quietMs: Int?
    private var calmSinceMs: Int?

    public init(activeFps: Double, idleFps: Double, stillFramesBeforeIdle: Int = 8, quietMs: Int? = nil) {
        self.activeFps = activeFps
        // An idle rate at or above the active one has nothing to save; clamping keeps a
        // mis-set pair from making the recording FASTER when nothing is happening.
        self.idleFps = min(idleFps, activeFps)
        self.stillFramesBeforeIdle = max(1, stillFramesBeforeIdle)
        self.quietMs = quietMs.map { max(0, $0) }
        self.currentFps = activeFps
    }

    /// The calm time the default of eight still frames lasts at the active rate.
    public static func defaultQuietMs(activeFps: Double, stillFrames: Int = 8) -> Int {
        Int((Double(stillFrames) * 1000 / max(0.01, activeFps)).rounded())
    }

    /// Feeds one decision in at `atMs`. With `quietMs` the idle rate starts once no frame moved for that long;
    /// without it this is `observe(kept:)`.
    public mutating func observe(kept: Bool, atMs: Int) -> Double? {
        guard let quietMs else { return observe(kept: kept) }
        if kept || calmSinceMs == nil {
            calmSinceMs = atMs
            return kept ? switchTo(activeFps) : nil
        }
        guard atMs - (calmSinceMs ?? atMs) >= quietMs else { return nil }

        return switchTo(idleFps)
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

/// The H.264 average bit rate for a screen movie: 0.15 bit per pixel per frame, so text stays sharp while it
/// scrolls, between 6 and 160 Mbit/s. Without it the encoder picked its own rate, and a fast scroll smeared.
public func screenMovieBitRate(width: Int, height: Int, fps: Double) -> Int {
    let bits = Double(width * height) * max(1, fps) * 0.15
    return Int(min(160_000_000, max(6_000_000, bits)))
}

/// Output stays fixed during a movie. The live canvas fits without stretching; global CG
/// coordinates are translated before Core Image's bottom-left coordinate flip.
public struct CaptureCanvasGeometry {
    public let canvas: CGRect
    public let output: CGSize
    public var scale: CGFloat { min(output.width / canvas.width, output.height / canvas.height) }
    public init(canvas: CGRect, output: CGSize) {
        self.canvas = canvas
        self.output = output
    }
    public func destination(for window: CGRect) -> CGRect {
        let paddingX = (output.width - canvas.width * scale) / 2
        let paddingY = (output.height - canvas.height * scale) / 2
        return CGRect(x: paddingX + (window.minX - canvas.minX) * scale,
                      y: paddingY + (canvas.maxY - window.maxY) * scale,
                      width: window.width * scale, height: window.height * scale)
    }
}
