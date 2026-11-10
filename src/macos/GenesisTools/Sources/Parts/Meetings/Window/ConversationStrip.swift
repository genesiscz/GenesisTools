import SwiftUI

// MARK: - The whole-conversation strip above the zoomed timeline (R47, G-A11Y-1)

/// The entire conversation, drawn like the zoomed timeline, with the zoomed part highlighted as a lens. Dragging the
/// lens, or clicking beside it, reports a new zoom range (a view change only: the sound goes on, R4). VoiceOver reads it
/// as one adjustable element: swipe up or down moves the lens by half its width.
struct ConversationStrip: View {
    /// The meeting's length (`meeting.audio` durationSec, or the waveform's toSec).
    let durationSec: Double
    /// `meeting.waveform` peaks over the whole meeting.
    let peaks: [Double]
    /// The part the zoomed timeline shows.
    let zoom: ClosedRange<Double>
    /// The player's position, read only by the playhead.
    let position: () -> Double?
    var pins: [TimelinePin] = []
    /// Who talks when: the waveform's colours (empty: one colour).
    var voices: [VoiceSpan] = []
    var height: CGFloat = 74
    /// The lens is never drawn narrower than this, so a 25 s clip in a 2 h meeting stays visible and draggable.
    var minLensWidth: CGFloat = 9
    /// A new zoom range, of the same length, from a drag, a click or VoiceOver.
    var onZoom: (ClosedRange<Double>) -> Void = { _ in }
    var pinActions: TimelinePinsRow.Actions = .init()

    @State private var dragStart: ClosedRange<Double>?

    private var whole: ClosedRange<Double> { 0...max(1, durationSec) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(verbatim: "Whole conversation · \(MeetingsFormat.clock(0)) to \(MeetingsFormat.clock(durationSec))")
                Spacer(minLength: 8)
                PinLegend()
            }
            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            .accessibilityHidden(true)
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .topLeading) {
                    // Every layer maps a second onto the same inner width, so a pin, a mark and the lens agree.
                    if !pins.isEmpty {
                        TimelinePinsRow(pins: pins, view: whole, actions: pinActions, showsText: false)
                            .frame(width: width - 8, height: 16).offset(x: 4, y: 2)
                    }
                    WaveformBars(peaks: peaks, peaksRange: whole, view: whole, clip: zoom, voices: voices)
                        .frame(width: width - 8, height: height - 38)
                        .offset(x: 4, y: 20)
                        .contentShape(Rectangle())
                        .gesture(dragGesture(width: width - 8))
                    TimelineGrid(view: whole).frame(width: width - 8, height: height - 34).offset(x: 4, y: 18)
                    lens(width: width - 8).offset(x: 4)
                    TimelinePlayhead(position: position, view: whole)
                        .frame(width: width - 8, height: height - 32).offset(x: 4, y: 17)
                    TimelineRuler(view: whole, edges: false).frame(width: width - 8).offset(x: 4, y: height - 14)
                }
                .frame(width: width, height: height, alignment: .topLeading)
            }
            .frame(height: height)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Whole conversation")
            .accessibilityValue("Showing \(MeetingsFormat.clock(zoom.lowerBound)) to \(MeetingsFormat.clock(zoom.upperBound)) of \(MeetingsFormat.clock(durationSec))")
            .accessibilityAdjustableAction { direction in
                let step = max(1, (zoom.upperBound - zoom.lowerBound) / 2)
                switch direction {
                case .increment: onZoom(ConversationStrip.moved(zoom, by: step, within: whole))
                case .decrement: onZoom(ConversationStrip.moved(zoom, by: -step, within: whole))
                @unknown default: break
                }
            }
            .accessibilityIdentifier("meetings.timeline.strip")
        }
    }

    private func lens(width: CGFloat) -> some View {
        let x = TimelineGeometry.x(zoom.lowerBound, in: whole, width: width)
        let end = TimelineGeometry.x(zoom.upperBound, in: whole, width: width)
        let lensWidth = max(minLensWidth, end - x)
        let left = min(max(0, (x + end) / 2 - lensWidth / 2), width - lensWidth)
        return ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.primary.opacity(0.12))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.primary, lineWidth: 1.5))
                .frame(width: lensWidth, height: height - 32)
                .offset(x: left, y: 17)
                .allowsHitTesting(false)
            Text(verbatim: "\(MeetingsFormat.clock(zoom.lowerBound)) to \(MeetingsFormat.clock(zoom.upperBound))")
                .font(.system(size: 10).monospacedDigit())
                .padding(.horizontal, 5)
                .background(RoundedRectangle(cornerRadius: 4).fill(.regularMaterial))
                .fixedSize()
                .offset(x: left + lensWidth + 120 > width ? left - 118 : left + lensWidth + 4, y: 22)
                .allowsHitTesting(false)
        }
    }

    /// A drag that starts on the lens moves it; a drag or a click beside it centres the lens on the pointer.
    private func dragGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let start = dragStart ?? zoom
                if dragStart == nil { dragStart = zoom }
                let lensX = TimelineGeometry.x(start.lowerBound, in: whole, width: width)
                let lensEnd = TimelineGeometry.x(start.upperBound, in: whole, width: width)
                let onLens = value.startLocation.x >= lensX - 6 && value.startLocation.x <= lensEnd + 6
                if onLens {
                    let delta = Double(value.translation.width / max(1, width)) * (whole.upperBound - whole.lowerBound)
                    onZoom(ConversationStrip.moved(start, by: delta, within: whole))
                } else {
                    onZoom(ConversationStrip.centred(start, at: TimelineGeometry.sec(atX: value.location.x, in: whole, width: width), within: whole))
                }
            }
            .onEnded { _ in dragStart = nil }
    }

    /// `range` moved by `delta` seconds, kept inside `whole` with its length.
    static func moved(_ range: ClosedRange<Double>, by delta: Double, within whole: ClosedRange<Double>) -> ClosedRange<Double> {
        let length = min(range.upperBound - range.lowerBound, whole.upperBound - whole.lowerBound)
        let from = min(max(whole.lowerBound, range.lowerBound + delta), whole.upperBound - length)
        return from...(from + length)
    }

    /// `range` centred on `sec`, kept inside `whole` with its length.
    static func centred(_ range: ClosedRange<Double>, at sec: Double, within whole: ClosedRange<Double>) -> ClosedRange<Double> {
        let half = (range.upperBound - range.lowerBound) / 2
        return moved(range, by: sec - half - range.lowerBound, within: whole)
    }
}

/// The two lines that join the lens on the strip to the zoomed timeline under it (the sketch's connector).
struct ZoomConnector: View {
    let zoom: ClosedRange<Double>
    let durationSec: Double

    var body: some View {
        Canvas { context, size in
            let whole = 0...max(1, durationSec)
            let inner = size.width - 8
            let left = 4 + TimelineGeometry.x(zoom.lowerBound, in: whole, width: inner)
            let right = 4 + TimelineGeometry.x(zoom.upperBound, in: whole, width: inner)
            var fill = Path()
            fill.move(to: CGPoint(x: left, y: 0))
            fill.addLine(to: CGPoint(x: right, y: 0))
            fill.addLine(to: CGPoint(x: size.width, y: size.height))
            fill.addLine(to: CGPoint(x: 0, y: size.height))
            fill.closeSubpath()
            context.fill(fill, with: .color(Color.accentColor.opacity(0.1)))
            var lines = Path()
            lines.move(to: CGPoint(x: left, y: 0)); lines.addLine(to: CGPoint(x: 0, y: size.height))
            lines.move(to: CGPoint(x: right, y: 0)); lines.addLine(to: CGPoint(x: size.width, y: size.height))
            context.stroke(lines, with: .color(Color.primary.opacity(0.3)), lineWidth: 0.5)
        }
        .frame(height: 14)
        .accessibilityHidden(true)
    }
}
