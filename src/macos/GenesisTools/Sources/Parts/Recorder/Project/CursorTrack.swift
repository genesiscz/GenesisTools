import CoreImage
import Foundation

/// The recorder's cursor sidecar (`cursor.jsonl`): one JSON object per sample, `{"t": <ms since the movie's first
/// frame>, "x": 0...1, "y": 0...1}` from the top left of the recorded display, plus `"click": "left" | "right"` on a
/// press. ax-tool's capture writes it beside `--video-out` (`--cursor-track`). Read once, kept sorted.
///
/// A movie recorded without the system cursor (`--hide-cursor --cursor-shapes`) has `"shape": "<hash>"` on the row
/// where the cursor's image changed and `"pw"` (the recorded width in points) on the first row; the images are
/// `cursor-shapes/<hash>.png` (2x) and `.json` (hotspot) beside the track. The editor then draws the cursor itself.
final class CursorTrack: @unchecked Sendable {
    struct Sample: Equatable {
        var ms: Double
        var x: Double
        var y: Double
        var click: String?
        var shape: String?
        /// A ⌘/⌃ shortcut pressed at this sample ("⌘⇧4").
        var key: String?
    }

    /// One cursor image: twice its point size, with the hotspot in points from its top left.
    struct Shape {
        let image: CIImage
        let hotX: Double
        let hotY: Double
        let width: Double
        let height: Double
    }

    let samples: [Sample]
    /// The presses, in time order; kept once because the click highlight reads them for every frame.
    let clicks: [Sample]
    /// The rows where the cursor's image changed. Empty when the system cursor is in the picture.
    let shapeChanges: [Sample]
    let shapes: [String: Shape]
    /// The recorded rectangle's width in points, so a movie pixel can be measured in cursor points.
    let pointWidth: Double?

    /// The shortcuts pressed, in time order.
    let keys: [Sample]

    /// The times the pointer moved or clicked: what keeps a cursor that hides when idle on screen.
    let moveTimes: [Double]

    /// The tracks without jitter, one per threshold (the smooth cursor); built once, read by every frame.
    private let smoothLock = NSLock()
    private var smoothTracks: [Int: CursorTrack] = [:]

    /// The movie has no system cursor in it, so the editor draws one.
    var drawsCursor: Bool { !shapeChanges.isEmpty && !shapes.isEmpty }

    init(samples: [Sample], shapes: [String: Shape] = [:], pointWidth: Double? = nil) {
        self.samples = samples.sorted { $0.ms < $1.ms }
        clicks = self.samples.filter { $0.click != nil }
        shapeChanges = self.samples.filter { $0.shape != nil }
        keys = self.samples.filter { $0.key != nil }
        var moves: [Double] = []
        var previous: Sample?
        for sample in self.samples {
            if let previous, sample.click == nil, abs(previous.x - sample.x) < 0.0001, abs(previous.y - sample.y) < 0.0001 {
                continue
            }
            moves.append(sample.ms)
            previous = sample
        }
        moveTimes = moves
        self.shapes = shapes
        self.pointWidth = pointWidth
    }

    static func load(_ path: String?) -> CursorTrack? {
        guard let path, let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        var samples: [Sample] = []
        var pointWidth: Double?
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ms = row["t"] as? Double, let x = row["x"] as? Double, let y = row["y"] as? Double else { continue }
            samples.append(Sample(ms: ms, x: x, y: y, click: row["click"] as? String, shape: row["shape"] as? String,
                                  key: row["key"] as? String))
            if let width = row["pw"] as? Double, width > 0 { pointWidth = width }
        }
        guard !samples.isEmpty else { return nil }
        let ids = Set(samples.compactMap(\.shape))
        let folder = ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent("cursor-shapes")
        return CursorTrack(samples: samples, shapes: loadShapes(ids, folder: folder), pointWidth: pointWidth)
    }

    private static func loadShapes(_ ids: Set<String>, folder: String) -> [String: Shape] {
        var shapes: [String: Shape] = [:]
        for id in ids {
            let base = (folder as NSString).appendingPathComponent(id)
            guard let image = CIImage(contentsOf: URL(fileURLWithPath: base + ".png")),
                  let data = FileManager.default.contents(atPath: base + ".json"),
                  let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
                  let width = meta["width"], let height = meta["height"], width > 0, height > 0 else { continue }
            shapes[id] = Shape(image: image, hotX: meta["hotX"] ?? 0, hotY: meta["hotY"] ?? 0, width: width, height: height)
        }
        return shapes
    }

    /// The cursor's image at the time: the last change at or before it (the first image before the first change).
    func shape(atMs ms: Double) -> Shape? {
        var low = 0, high = shapeChanges.count
        while low < high {
            let mid = (low + high) / 2
            if shapeChanges[mid].ms <= ms { low = mid + 1 } else { high = mid }
        }
        let change = low > 0 ? shapeChanges[low - 1] : shapeChanges.first
        return change?.shape.flatMap { shapes[$0] }
    }

    /// Where the pointer was. A row is written only when it moved (60 Hz), so a gap means it stood still: it holds
    /// the earlier place until one sample before the next row, then moves there.
    func point(atMs ms: Double) -> (x: Double, y: Double)? {
        guard !samples.isEmpty else { return nil }
        let next = firstIndex(atOrAfter: ms)
        if next == 0 { return (samples[0].x, samples[0].y) }
        if next >= samples.count { return (samples[samples.count - 1].x, samples[samples.count - 1].y) }
        let a = samples[next - 1], b = samples[next]
        let start = max(a.ms, b.ms - 16.7)
        guard ms > start, b.ms > start else { return (a.x, a.y) }
        let f = (ms - start) / (b.ms - start)
        return (a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f)
    }

    /// The drawn cursor's place: a Gaussian average of the path over up to ±120 ms × `smoothing` (0...1). The window
    /// narrows near a click, so the cursor sits exactly where it clicked.
    func drawnPoint(atMs ms: Double, smoothing: Double) -> (x: Double, y: Double)? {
        drawnPoint(atMs: ms, halfMs: max(0, min(1, smoothing)) * 120)
    }

    /// The path averaged over ±`halfMs`, narrowed near a click so the cursor sits exactly where it clicked.
    func drawnPoint(atMs ms: Double, halfMs: Double) -> (x: Double, y: Double)? {
        var half = halfMs
        if let nearest = nearestClickDistance(ms) { half = min(half, nearest * 0.8) }
        return averagedPoint(atMs: ms, halfMs: half)
    }

    /// The path averaged with Gaussian weights over ±`halfMs`: what a crop that follows the cursor centres on, wide
    /// enough that it glides instead of chasing every move.
    func averagedPoint(atMs ms: Double, halfMs half: Double) -> (x: Double, y: Double)? {
        guard half > 1 else { return point(atMs: ms) }
        let sigma = half / 2
        var sumX = 0.0, sumY = 0.0, sumW = 0.0
        // A tap about every 20 ms: coarser taps turned one quick move into visible steps of the view.
        let taps = max(6, Int(half / 20))
        for step in -taps...taps {
            let offset = half * Double(step) / Double(taps)
            guard let p = point(atMs: ms + offset) else { continue }
            let weight = exp(-(offset * offset) / (2 * sigma * sigma))
            sumX += p.x * weight
            sumY += p.y * weight
            sumW += weight
        }
        return sumW > 0 ? (sumX / sumW, sumY / sumW) : point(atMs: ms)
    }

    /// 1 while the pointer moved within `hideAfterMs`, then down to 0 over 300 ms; back to 1 the moment it moves.
    func visibility(atMs ms: Double, hideAfterMs: Int) -> Double {
        guard hideAfterMs > 0, !moveTimes.isEmpty else { return 1 }
        var low = 0, high = moveTimes.count
        while low < high {
            let mid = (low + high) / 2
            if moveTimes[mid] <= ms { low = mid + 1 } else { high = mid }
        }
        // A move row lands one sample after the motion starts; the next one counts from that sample.
        if low < moveTimes.count, moveTimes[low] - ms <= 16.7 { return 1 }
        guard low > 0 else { return 1 }
        let still = ms - moveTimes[low - 1] - Double(hideAfterMs)
        return max(0, min(1, 1 - still / 300))
    }

    /// The shortcut showing at the time: the last press within `durationMs`, with its opacity (out over the last
    /// 250 ms). A newer press replaces an older one at once.
    func key(atMs ms: Double, durationMs: Int) -> (label: String, opacity: Double)? {
        var low = 0, high = keys.count
        while low < high {
            let mid = (low + high) / 2
            if keys[mid].ms <= ms { low = mid + 1 } else { high = mid }
        }
        guard low > 0, let label = keys[low - 1].key else { return nil }
        let age = ms - keys[low - 1].ms
        let duration = Double(max(300, durationMs))
        guard age < duration else { return nil }
        return (label, min(1, (duration - age) / 250))
    }

    private func nearestClickDistance(_ ms: Double) -> Double? {
        guard !clicks.isEmpty else { return nil }
        var low = 0, high = clicks.count
        while low < high {
            let mid = (low + high) / 2
            if clicks[mid].ms < ms { low = mid + 1 } else { high = mid }
        }
        var best = Double.infinity
        if low < clicks.count { best = min(best, clicks[low].ms - ms) }
        if low > 0 { best = min(best, ms - clicks[low - 1].ms) }
        return best
    }



    private func firstIndex(atOrAfter ms: Double) -> Int {
        var low = 0, high = samples.count
        while low < high {
            let mid = (low + high) / 2
            if samples[mid].ms < ms { low = mid + 1 } else { high = mid }
        }
        return low
    }
}

// fx B (round 4): the smooth cursor (EditProject.CursorSmooth, src/utils/recording-editor/cursor-smooth.ts).
extension CursorTrack {
    /// The widest average the smooth cursor uses, at strength 1.
    static let smoothMaxHalfMs = 400.0

    /// The track without its jitter: a sample closer than `points` (recorded points) to the last one kept is dropped,
    /// so the cursor holds still where the hand only trembled. A click, a shape change or a shortcut is always kept.
    /// `aspect` is the picture's height over its width, so a step up counts as much as the same step across.
    func dejittered(points: Double, aspect: Double) -> CursorTrack {
        guard points > 0, !samples.isEmpty else { return self }
        let key = Int((points * 100).rounded()) &* 31 &+ Int((aspect * 1000).rounded())
        smoothLock.lock()
        if let cached = smoothTracks[key] {
            smoothLock.unlock()
            return cached
        }
        smoothLock.unlock()
        // A recording without its width in points is taken as a 1440-point display.
        let threshold = points / (pointWidth ?? 1440)
        var kept: [Sample] = []
        for sample in samples {
            if let last = kept.last, sample.click == nil, sample.shape == nil, sample.key == nil,
               hypot(sample.x - last.x, (sample.y - last.y) * aspect) < threshold {
                continue
            }
            kept.append(sample)
        }
        let track = CursorTrack(samples: kept, shapes: shapes, pointWidth: pointWidth)
        smoothLock.lock()
        smoothTracks[key] = track
        smoothLock.unlock()
        return track
    }

    /// Where the smooth cursor is drawn and how visible it is: on the track without jitter, averaged over up to
    /// ±400 ms × strength (exact at a click), fading after `idleFadeSeconds` without a move.
    func smoothMark(atMs ms: Double, settings: EditProject.CursorSmooth, aspect: Double) -> (x: Double, y: Double, opacity: Double)? {
        let track = dejittered(points: settings.jitterPx, aspect: aspect)
        guard let point = track.drawnPoint(atMs: ms, halfMs: max(0, min(1, settings.strength)) * Self.smoothMaxHalfMs) else { return nil }
        let opacity = track.visibility(atMs: ms, hideAfterMs: Int((settings.idleFadeSeconds * 1000).rounded()))
        return (point.x, point.y, opacity)
    }
}
