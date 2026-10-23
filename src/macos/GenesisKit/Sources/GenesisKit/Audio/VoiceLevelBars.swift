import SwiftUI

/// Seven bars that move with the voice level while someone talks: the Flow pill's bars, shared so the widget's reply
/// box shows the same waves (Martin, 2026-10-23: "you should show me the "waves" as i am talking").
///
/// The recognisers expose one RMS level, not a spectrum, so these are one amplitude shaped by fixed per-bar weights:
/// a motion cue, not a frequency display.
public struct VoiceLevelBars: View {
    /// The level, 0 to 1.
    public var level: Double
    /// Listening: full height range and opacity. Otherwise the bars rest at their base height, dimmed.
    public var active: Bool
    public var tint: Color
    public var reduceMotion: Bool

    public init(level: Double, active: Bool = true, tint: Color, reduceMotion: Bool = false) {
        self.level = level
        self.active = active
        self.tint = tint
        self.reduceMotion = reduceMotion
    }

    static let weights: [Double] = [0.45, 0.7, 0.95, 1.0, 0.9, 0.65, 0.4]

    public var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<Self.weights.count, id: \.self) { index in
                Capsule()
                    .fill(tint)
                    .frame(width: 3, height: height(index))
                    .opacity(active ? 1 : 0.35)
            }
        }
        .frame(width: 44, height: 22, alignment: .center)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: level)
        .accessibilityHidden(true)
    }

    func height(_ index: Int) -> CGFloat {
        let base: CGFloat = 4
        guard active else { return base }
        return base + CGFloat(max(0, min(1, level)) * Self.weights[index]) * 16
    }
}
