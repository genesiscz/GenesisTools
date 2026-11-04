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

    /// The movie has no system cursor in it, so the editor draws one.
    var drawsCursor: Bool { !shapeChanges.isEmpty && !shapes.isEmpty }

    init(samples: [Sample], shapes: [String: Shape] = [:], pointWidth: Double? = nil) {
        self.samples = samples.sorted { $0.ms < $1.ms }
        clicks = self.samples.filter { $0.click != nil }
        shapeChanges = self.samples.filter { $0.shape != nil }
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
            samples.append(Sample(ms: ms, x: x, y: y, click: row["click"] as? String, shape: row["shape"] as? String))
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
        var half = max(0, min(1, smoothing)) * 120
        if let nearest = nearestClickDistance(ms) { half = min(half, nearest * 0.8) }
        guard half > 1 else { return point(atMs: ms) }
        let sigma = half / 2
        var sumX = 0.0, sumY = 0.0, sumW = 0.0
        for step in -6...6 {
            let offset = half * Double(step) / 6
            guard let p = point(atMs: ms + offset) else { continue }
            let weight = exp(-(offset * offset) / (2 * sigma * sigma))
            sumX += p.x * weight
            sumY += p.y * weight
            sumW += weight
        }
        return sumW > 0 ? (sumX / sumW, sumY / sumW) : point(atMs: ms)
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


    /// The cursor position averaged over 300 ms around the time, so a followed zoom glides instead of shaking.
    func smoothedPoint(atUs us: Int64) -> (x: Double, y: Double)? {
        let ms = Double(us) / 1000
        let low = firstIndex(atOrAfter: ms - 150)
        var sumX = 0.0, sumY = 0.0, count = 0.0
        var index = low
        while index < samples.count, samples[index].ms <= ms + 150 {
            sumX += samples[index].x
            sumY += samples[index].y
            count += 1
            index += 1
        }
        if count > 0 { return (sumX / count, sumY / count) }
        // No sample in the window: the nearest one before it holds.
        let before = low - 1
        return before >= 0 ? (samples[before].x, samples[before].y) : nil
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
