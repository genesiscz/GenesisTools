import SwiftUI

// MARK: - The playing row's mini bar (R25, R46, G-ROW-1, G-ROW-2)

/// The bar that replaces a playing row's subtitle line, at the same height (G-ROW-1): the clip from its start to its
/// end, the pad dim, the asked span bright, the flag on the boundary where the asked part begins (R46), the playhead,
/// and the clip's length ("15 s clip") at the end. The flag has a 22 pt hit area and plays from just before the tone (G-PLAY-3); a
/// click on the bar seeks there. VoiceOver reads one adjustable element: swipe up or down seeks by `stepSec`.
struct PlayingRowBar: View {
    let span: ZoomSpan
    /// The player's position, read only by the playhead.
    let position: () -> Double?
    /// The subtitle line's height, so the row does not change height when it starts or stops playing.
    var height: CGFloat = 17
    var stepSec: Double = 5
    /// "15 s clip" after the bar. A narrow header leaves it out: the row's own time stands beside the bar.
    var showsLength = true
    var onFlag: (Double) -> Void = { _ in }
    var onSeek: (Double) -> Void = { _ in }

    /// The least width the bar is readable at: room for the pad, the asked span and the flag, and for the clip's
    /// length when it shows it ("12 min clip").
    static func smallestWidth(length: Bool) -> CGFloat { length ? 160 : 90 }

    /// "7 s clip": how long the clip plays. The clip's two ends stood here ("1:49:47 → 1:49:54"), one second from the
    /// row's own span beside the bar ("1:49:48–1:49:54"), and nothing said why the two ranges differ.
    static func lengthText(_ span: ZoomSpan) -> String {
        "\(MeetingsFormat.length(span.endSec - span.startSec) ?? "0 s") clip"
    }

    private var clip: ClosedRange<Double> { span.startSec...max(span.startSec + 0.1, span.endSec) }

    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { proxy in
                let width = proxy.size.width
                let askX = TimelineGeometry.x(span.fromSec, in: clip, width: width)
                let askEnd = TimelineGeometry.x(max(span.fromSec, span.toSec), in: clip, width: width)
                let mid = height / 2
                ZStack(alignment: .topLeading) {
                    Capsule().fill(Color.accentColor.opacity(0.25)).frame(width: width, height: 4).offset(y: mid - 2)
                    Rectangle().fill(Color.accentColor.opacity(0.15))
                        .frame(width: askX, height: 8).offset(y: mid - 4)
                    Rectangle().fill(Color.accentColor.opacity(0.45))
                        .frame(width: max(2, askEnd - askX), height: 10).offset(x: askX, y: mid - 5)
                    TimelinePlayhead(position: position, view: clip)
                        .frame(width: width, height: height - 2).offset(y: 1)
                    // The flag alone: the row's time button beside the bar already says the asked time, and the
                    // time on the flag covered half of a short bar.
                    FlagMark(text: "", lineHeight: height, accessibility:
                             "Asked spot at \(MeetingsFormat.clock(span.spotSec)). Plays from there.", compact: true) {
                        onFlag(span.flagSeekTarget)
                    }
                    .offset(x: askX - FlagMark.lineX, y: (height - max(22, height)) / 2)
                }
                .frame(width: width, height: height, alignment: .topLeading)
                .contentShape(Rectangle())
                .onTapGesture(coordinateSpace: .local) { point in
                    onSeek(TimelineGeometry.sec(atX: point.x, in: clip, width: width))
                }
            }
            .frame(height: height)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Playing clip, \(MeetingsFormat.clock(span.startSec)) to \(MeetingsFormat.clock(span.endSec)), asked spot \(MeetingsFormat.clock(span.spotSec))")
            .accessibilityValue(MeetingsFormat.clock(position() ?? span.startSec))
            .accessibilityAdjustableAction { direction in
                let at = position() ?? span.startSec
                switch direction {
                case .increment: onSeek(min(span.endSec, at + stepSec))
                case .decrement: onSeek(max(span.startSec, at - stepSec))
                @unknown default: break
                }
            }
            .accessibilityAction(named: "Play from the asked spot") { onFlag(span.flagSeekTarget) }
            .accessibilityIdentifier("meetings.row.minibar")
            if showsLength {
                Text(verbatim: Self.lengthText(span))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .accessibilityHidden(true)
            }
        }
        .frame(height: height)
    }
}
