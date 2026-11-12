import SwiftUI

/// Only the active chip reads the ten-Hz playhead. Peaks are already held by the dock; rendering does no I/O.
struct MomentActivityGlyph: View {
    let player: MomentPlayer
    let meeting: String

    var body: some View {
        let at = player.position ?? 0
        let cached = player.timeline.activityPeaks(meeting, at: at)
        let levels = Self.heights(cached.peaks, range: cached.range, at: at)
        Group {
            if levels.isEmpty {
                Image(systemName: "pause.fill").font(.system(size: 8.5, weight: .bold))
            } else {
                HStack(alignment: .center, spacing: 1) {
                    ForEach(levels.indices, id: \.self) { index in
                        Capsule().frame(width: 2, height: levels[index])
                    }
                }
                .animation(.linear(duration: 0.09), value: levels)
            }
        }
        .frame(width: 9, height: 10)
        .allowsHitTesting(false)
    }

    /// A short trailing window of the recording, bounded to the chip's height. Empty means no waveform yet.
    static func heights(_ peaks: [Double], range: ClosedRange<Double>, at: Double) -> [CGFloat] {
        guard at.isFinite else { return [] }
        let view = max(0, at - 0.36)...max(0.01, at)
        return TimelineGeometry.bars(peaks, peaksRange: range, view: view, count: 3).map { peak in
            let level = peak.isFinite ? min(1, max(0, peak)) : 0
            return CGFloat(1 + 9 * sqrt(level))
        }
    }
}
