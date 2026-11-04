import Foundation

/// The recorder's cursor sidecar (`cursor.jsonl`): one JSON object per sample, `{"t": <ms since the movie's first
/// frame>, "x": 0...1, "y": 0...1}` from the top left of the recorded display, plus `"click": "left" | "right"` on a
/// press. ax-tool's capture writes it beside `--video-out` (`--cursor-track`). Read once, kept sorted.
final class CursorTrack: @unchecked Sendable {
    struct Sample: Equatable {
        var ms: Double
        var x: Double
        var y: Double
        var click: String?
    }

    let samples: [Sample]
    /// The presses, in time order; kept once because the click highlight reads them for every frame.
    let clicks: [Sample]

    init(samples: [Sample]) {
        self.samples = samples.sorted { $0.ms < $1.ms }
        clicks = self.samples.filter { $0.click != nil }
    }

    static func load(_ path: String?) -> CursorTrack? {
        guard let path, let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        var samples: [Sample] = []
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ms = row["t"] as? Double, let x = row["x"] as? Double, let y = row["y"] as? Double else { continue }
            samples.append(Sample(ms: ms, x: x, y: y, click: row["click"] as? String))
        }
        return samples.isEmpty ? nil : CursorTrack(samples: samples)
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
