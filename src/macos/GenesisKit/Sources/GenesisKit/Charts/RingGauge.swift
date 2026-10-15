import SwiftUI

/// A progress ring: a quiet track and an arc from twelve o'clock, clockwise, with round ends and a soft sweep from a
/// lighter start to the full tint. Anything can sit in the middle (a percentage, an icon). A change of `progress`
/// glides on the `GenMotion` curve (at once under Reduce Motion); changes under half a percent apply without an
/// animation, so a host may feed raw values often. The ring draws nothing at rest.
///
/// Identifier: `identifier`, when given, on the gauge.
public struct RingGauge<Center: View>: View {
    private let progress: Double
    private let tint: Color
    private let track: Color
    private let lineWidth: CGFloat
    private let label: String?
    private let identifier: String?
    private let center: Center
    @GenReduceMotion private var reduceMotion

    /// - Parameters:
    ///   - progress: 0...1; values outside are clamped.
    ///   - label: what the gauge measures, for accessibility ("Disk used"); its value is the percentage.
    public init(
        progress: Double, tint: Color = .accentColor, track: Color = .white.opacity(0.09), lineWidth: CGFloat = 8,
        label: String? = nil, identifier: String? = nil, @ViewBuilder center: () -> Center
    ) {
        self.progress = progress.isFinite ? min(1, max(0, progress)) : 0
        self.tint = tint
        self.track = track
        self.lineWidth = lineWidth
        self.label = label
        self.identifier = identifier
        self.center = center()
    }

    public var body: some View {
        ZStack {
            Circle()
                .stroke(track, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(
                    AngularGradient(
                        gradient: Gradient(colors: [tint.opacity(0.55), tint]), center: .center,
                        startAngle: .degrees(0), endAngle: .degrees(max(1, 360 * progress))),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            center
                .padding(lineWidth + 4)
        }
        .padding(lineWidth / 2)
        .animation(
            GenMotion.animation(expanding: true, reduceMotion: reduceMotion, scale: 1.6),
            value: Int((progress * 200).rounded()))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label ?? "Progress")
        .accessibilityValue("\(Int((progress * 100).rounded())) percent")
        .chartAccessibilityIdentifier(identifier)
    }
}

public extension RingGauge where Center == EmptyView {
    init(
        progress: Double, tint: Color = .accentColor, track: Color = .white.opacity(0.09), lineWidth: CGFloat = 8,
        label: String? = nil, identifier: String? = nil
    ) {
        self.init(
            progress: progress, tint: tint, track: track, lineWidth: lineWidth, label: label, identifier: identifier
        ) { EmptyView() }
    }
}
