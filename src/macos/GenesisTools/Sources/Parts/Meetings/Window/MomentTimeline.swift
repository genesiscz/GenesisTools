import SwiftUI

// MARK: - The zoomed timeline of the dock (R1, R2, R4, R46, G-PLAY-1, G-PLAY-3, G-PLAY-4)
//
// Presentational only: it draws plain values and reports what the reader did through closures. The wiring agent feeds
// it from MomentPlayer's top layer and `meeting.waveform`, and calls the player from the closures.

/// What the zoomed timeline shows of one Moment: the audio it plays (`startSec` to `endSec`, the pad included), the
/// asked span (`fromSec` to `toSec`), the asked spot and the tone, all on the meeting clock.
struct ZoomSpan: Equatable {
    var startSec: Double
    var endSec: Double
    var fromSec: Double
    var toSec: Double
    var spotSec: Double
    var toneSec: Double?
    /// A range question ("Who says this between 1:49:48 and 1:50:02?"): the flag at its start and a tick at its end
    /// (G-PLAY-4). Else only the flag.
    var isRange: Bool
    /// The flag's words after its time: `"OMP" → "EMP"`.
    var label: String

    init(startSec: Double, endSec: Double, fromSec: Double, toSec: Double, spotSec: Double, toneSec: Double? = nil,
         isRange: Bool = false, label: String) {
        self.startSec = startSec
        self.endSec = endSec
        self.fromSec = fromSec
        self.toSec = toSec
        self.spotSec = spotSec
        self.toneSec = toneSec
        self.isRange = isRange
        self.label = label
    }

    /// The span of an engine Moment. A `.range` target is a range question.
    init(moment: Moment) {
        var isRange = false
        if case .range = moment.target { isRange = true }
        self.init(startSec: moment.startSec, endSec: moment.endSec, fromSec: moment.fromSec, toSec: moment.toSec,
                  spotSec: moment.spotSec, toneSec: moment.tone?.atSec, isRange: isRange, label: moment.label)
    }

    /// The view that fits the clip with a third of its length free on each side (the sketch: a 15 s clip in 25 s).
    var fitView: ClosedRange<Double> {
        let margin = max(1, (endSec - startSec) / 3)
        return (startSec - margin)...(endSec + margin)
    }

    /// The Context view: `contextSec` (meetings.playback.contextSec) centred on the asked spot, never before 0 nor past
    /// `durationSec`.
    func contextView(contextSec: Double, durationSec: Double) -> ClosedRange<Double> {
        ConversationStrip.centred(0...max(1, contextSec), at: spotSec, within: 0...max(contextSec, durationSec))
    }

    /// Where a flag click plays from (G-PLAY-3).
    var flagSeekTarget: Double { TimelineGeometry.flagSeekTarget(toneSec: toneSec, spotSec: spotSec, clipStartSec: startSec) }
}

/// A stretch one speaker talks in, with that speaker's colour (the avatars' and the lanes').
struct VoiceSpan: Equatable {
    let fromSec: Double
    let toSec: Double
    let color: Color
}

/// A speaker in the legend under the timeline.
struct VoiceLegend: Equatable, Identifiable {
    let name: String
    let color: Color

    var id: String { name }
}

/// One label of the ruler: an end of the view, or a round mark.
struct RulerLabel: Equatable {
    enum Kind: Equatable { case start, end, mark }

    let sec: Double
    let x: CGFloat
    let kind: Kind
}

/// The timeline's pure rules: where a second sits, where a flag click plays from, the ruler's marks.
enum TimelineGeometry {
    /// The flag plays from 0.3 s before the tone, so the tone is heard whole (G-PLAY-3); from the spot when the Moment
    /// has no tone; never before the clip's own start. MomentPlayer.seekToSpot uses the same rule.
    static let flagLeadSec: Double = 0.3

    static func flagSeekTarget(toneSec: Double?, spotSec: Double, clipStartSec: Double) -> Double {
        max(clipStartSec, (toneSec ?? spotSec) - flagLeadSec)
    }

    /// The x of `sec` in a view of `range` that is `width` wide (clamped to the view).
    static func x(_ sec: Double, in range: ClosedRange<Double>, width: CGFloat) -> CGFloat {
        let length = range.upperBound - range.lowerBound
        guard length > 0, width > 0 else { return 0 }
        let fraction = min(1, max(0, (sec - range.lowerBound) / length))
        return CGFloat(fraction) * width
    }

    /// The second at `x` in a view of `range` that is `width` wide (clamped to the view).
    static func sec(atX x: CGFloat, in range: ClosedRange<Double>, width: CGFloat) -> Double {
        guard width > 0 else { return range.lowerBound }
        let fraction = min(1, max(0, Double(x / width)))
        return range.lowerBound + fraction * (range.upperBound - range.lowerBound)
    }

    /// Ruler marks on round seconds, at least `minGap` points apart.
    static func ticks(in range: ClosedRange<Double>, width: CGFloat, minGap: CGFloat = 70) -> [Double] {
        let length = range.upperBound - range.lowerBound
        guard length > 0, width > 0 else { return [] }
        let steps: [Double] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
        let step = steps.first { CGFloat($0 / length) * width >= minGap } ?? 7200
        var marks: [Double] = []
        var mark = (range.lowerBound / step).rounded(.up) * step
        while mark <= range.upperBound {
            marks.append(mark)
            mark += step
        }
        return marks
    }

    /// The ruler's labels: the view's two ends, so the reader sees where the timeline starts and ends (a view from
    /// 48:46 showed "50:00" as its first time), and the round marks that stand at least `edgeGap` from an end.
    static func rulerLabels(in range: ClosedRange<Double>, width: CGFloat, minGap: CGFloat = 70, edgeGap: CGFloat = 62) -> [RulerLabel] {
        guard range.upperBound > range.lowerBound, width > 0 else { return [] }
        var labels = [RulerLabel(sec: range.lowerBound, x: 0, kind: .start)]
        for mark in ticks(in: range, width: width, minGap: minGap) {
            let at = x(mark, in: range, width: width)
            if at >= edgeGap, at <= width - edgeGap { labels.append(RulerLabel(sec: mark, x: at, kind: .mark)) }
        }
        labels.append(RulerLabel(sec: range.upperBound, x: width, kind: .end))
        return labels
    }

    /// The voice of each of `count` bars over `view`: the colour that talks longest inside the bar, nil for a bar
    /// nobody talks in. `voices` in the order of their start.
    static func barVoices(_ voices: [VoiceSpan], view: ClosedRange<Double>, count: Int) -> [Color?] {
        guard count > 0 else { return [] }
        let length = view.upperBound - view.lowerBound
        var first = 0
        return (0..<count).map { bar in
            let from = view.lowerBound + length * Double(bar) / Double(count)
            let to = view.lowerBound + length * Double(bar + 1) / Double(count)
            while first < voices.count, voices[first].toSec <= from { first += 1 }
            var talk: [(color: Color, sec: Double)] = []
            var index = first
            while index < voices.count, voices[index].fromSec < to {
                let overlap = min(to, voices[index].toSec) - max(from, voices[index].fromSec)
                if overlap > 0 {
                    if let known = talk.firstIndex(where: { $0.color == voices[index].color }) {
                        talk[known].sec += overlap
                    } else {
                        talk.append((voices[index].color, overlap))
                    }
                }
                index += 1
            }
            return talk.max { $0.sec < $1.sec }?.color
        }
    }

    /// The peaks of a whole-range waveform that fall inside `view`, resampled to `count` bars.
    static func bars(_ peaks: [Double], peaksRange: ClosedRange<Double>, view: ClosedRange<Double>, count: Int) -> [Double] {
        guard !peaks.isEmpty, count > 0 else { return [] }
        let length = peaksRange.upperBound - peaksRange.lowerBound
        guard length > 0 else { return [] }
        let viewLength = view.upperBound - view.lowerBound
        return (0..<count).map { bar in
            let from = view.lowerBound + viewLength * Double(bar) / Double(count)
            let to = view.lowerBound + viewLength * Double(bar + 1) / Double(count)
            let first = Int(((from - peaksRange.lowerBound) / length * Double(peaks.count)).rounded(.down))
            let last = Int(((to - peaksRange.lowerBound) / length * Double(peaks.count)).rounded(.up))
            let lo = max(0, min(peaks.count - 1, first)), hi = max(lo + 1, min(peaks.count, last))
            return peaks[lo..<hi].max() ?? 0
        }
    }
}

/// A waveform drawn as bars in one Canvas: dim outside the clip, brighter in it, brightest in the asked span. With
/// `voices` each bar has the colour of the speaker who talks there, and the clip and the asked span show as strength.
struct WaveformBars: View {
    let peaks: [Double]
    /// The seconds the peaks cover.
    let peaksRange: ClosedRange<Double>
    /// The seconds the view shows.
    let view: ClosedRange<Double>
    /// The clip's audio and the asked span, when a Moment is shown.
    var clip: ClosedRange<Double>?
    var asked: ClosedRange<Double>?
    /// Who talks when, in the order of their start; empty draws the one-colour waveform.
    var voices: [VoiceSpan] = []
    var barWidth: CGFloat = 2
    var gap: CGFloat = 1

    var body: some View {
        Canvas { context, size in
            let count = max(1, Int(size.width / (barWidth + gap)))
            let bars = TimelineGeometry.bars(peaks, peaksRange: peaksRange, view: view, count: count)
            let owners = voices.isEmpty ? [] : TimelineGeometry.barVoices(voices, view: view, count: count)
            for (index, peak) in bars.enumerated() {
                let x = CGFloat(index) * (barWidth + gap)
                let sec = TimelineGeometry.sec(atX: x + barWidth / 2, in: view, width: size.width)
                let height = max(2, CGFloat(peak) * size.height)
                let rect = CGRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
                let inAsked = asked?.contains(sec) ?? false
                let inClip = clip?.contains(sec) ?? false
                let tone: Color
                if owners.indices.contains(index) {
                    // A speaker's colour: full in the asked span, strong in the clip, faint outside a clip.
                    let strength: Double = inAsked ? 1 : inClip ? 0.82 : clip == nil ? 0.85 : 0.4
                    tone = owners[index].map { $0.opacity(strength) } ?? Color.secondary.opacity(clip == nil || inClip ? 0.4 : 0.26)
                } else if inAsked { tone = Color.accentColor.opacity(0.95) }
                else if inClip { tone = Color.accentColor.opacity(0.55) }
                else { tone = Color.secondary.opacity(0.55) }
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(tone))
            }
        }
        .accessibilityHidden(true)
    }
}

/// The playhead line. It reads the position through a closure, so only this small view draws again on the player's
/// 10 Hz tick (pass `{ player.position }`), never the waveform or the pins.
struct TimelinePlayhead: View {
    let position: () -> Double?
    let view: ClosedRange<Double>

    var body: some View {
        GeometryReader { proxy in
            if let sec = position(), view.contains(sec) {
                Rectangle()
                    .fill(Color.primary)
                    .frame(width: 2)
                    .shadow(color: .black.opacity(0.35), radius: 0.5)
                    .offset(x: TimelineGeometry.x(sec, in: view, width: proxy.size.width) - 1)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The ruler's times over a view: the round marks, and with `edges` the view's own start and end at its two ends
/// (stronger, so a view that starts at 48:46 says so).
struct TimelineRuler: View {
    let view: ClosedRange<Double>
    var edges: Bool = true

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            if edges {
                ForEach(TimelineGeometry.rulerLabels(in: view, width: width), id: \.sec) { label in
                    switch label.kind {
                    case .mark:
                        time(label.sec, strong: false).position(x: label.x, y: proxy.size.height / 2)
                    case .start:
                        time(label.sec, strong: true).padding(.leading, 5).frame(width: width, height: proxy.size.height, alignment: .leading)
                    case .end:
                        time(label.sec, strong: true).padding(.trailing, 5).frame(width: width, height: proxy.size.height, alignment: .trailing)
                    }
                }
            } else {
                ForEach(TimelineGeometry.ticks(in: view, width: width), id: \.self) { mark in
                    let x = TimelineGeometry.x(mark, in: view, width: width)
                    time(mark, strong: false).position(x: min(max(x, 18), width - 18), y: proxy.size.height / 2)
                }
            }
        }
        .frame(height: 12)
        .accessibilityHidden(true)
    }

    private func time(_ sec: Double, strong: Bool) -> some View {
        Text(verbatim: MeetingsFormat.clock(sec))
            .font(.system(size: 10, weight: strong ? .semibold : .regular).monospacedDigit())
            .foregroundStyle(strong ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tertiary))
            .fixedSize()
    }
}

/// A line at each round mark of the ruler, through the waveform: the reader sees where "50:00" is, not only its
/// label above.
struct TimelineGrid: View {
    let view: ClosedRange<Double>

    var body: some View {
        Canvas { context, size in
            var lines = Path()
            for mark in TimelineGeometry.ticks(in: view, width: size.width) {
                let x = TimelineGeometry.x(mark, in: view, width: size.width).rounded() + 0.5
                lines.move(to: CGPoint(x: x, y: 0))
                lines.addLine(to: CGPoint(x: x, y: size.height))
            }
            context.stroke(lines, with: .color(Color.primary.opacity(0.22)), lineWidth: 1)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// What the pins' glyphs mean, in the pins' colours.
struct PinLegend: View {
    @Environment(\.kitLook) private var look

    var body: some View {
        if look == .classic {
            Text(verbatim: "⚑ open · ✓ answered · ? question")
        } else {
            HStack(spacing: 10) {
                item("flag.fill", "open", .care)
                item("checkmark", "answered", .done)
                item("questionmark", "question", .ask)
            }
        }
    }

    private func item(_ symbol: String, _ word: String, _ hue: KitHue) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 8.5, weight: .bold)).foregroundStyle(hue.ink)
            Text(verbatim: word)
        }
    }
}

/// Whose colour the waveform has where: a dot and a name per speaker, the most spoken first.
struct VoiceLegendRow: View {
    let voices: [VoiceLegend]
    var shown = 5

    var body: some View {
        HStack(spacing: 10) {
            ForEach(voices.prefix(shown)) { voice in
                HStack(spacing: 4) {
                    Circle().fill(voice.color).frame(width: 7, height: 7)
                    Text(verbatim: voice.name).lineLimit(1)
                }
            }
            if voices.count > shown { Text(verbatim: "and \(voices.count - shown) more") }
        }
        .font(.system(size: 10.5)).foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("The waveform's colours: \(voices.map(\.name).joined(separator: ", "))")
    }
}

/// The zoomed timeline: the clip with its pad shaded, the asked span, the flag on the span's boundary (R46), the end
/// tick of a range question (G-PLAY-4), the playhead, and under it the pad words. The view range is the caller's:
/// "Zoom out" asks for a wider one and never touches the sound (R4). At the clip's end it offers "Play 30 s more"
/// (G-PLAY-1). In whole-meeting mode (`span` nil) it shows the pins instead.
struct MomentTimeline: View {
    /// The Moment that plays; nil in whole-meeting mode.
    let span: ZoomSpan?
    /// The seconds the timeline shows (the clip, a context window, or the whole meeting).
    let view: ClosedRange<Double>
    /// The waveform's peaks and the seconds they cover (`meeting.waveform`).
    let peaks: [Double]
    let peaksRange: ClosedRange<Double>
    /// The player's position, read only by the playhead.
    let position: () -> Double?
    /// The pins, drawn in whole-meeting mode (and in a wide view, over the waveform).
    var pins: [TimelinePin] = []
    /// The top ended and `afterClip` is offerMore: show "Play N s more".
    var offerMore: Bool = false
    /// `meetings.playback.moreSec`.
    var moreSec: Double = 30
    /// Whether the view is wider than the clip (Zoom out is on): the button then says "Fit clip".
    var zoomedOut: Bool = false
    /// Who talks when (the waveform's colours) and the speakers' legend under it; empty: one colour, no legend.
    var voices: [VoiceSpan] = []
    var legend: [VoiceLegend] = []
    /// Rows the pins have in whole-meeting mode (`meetings.timeline.pinLanes`).
    var pinLanes: Int = 2
    var height: CGFloat = 112
    /// A flag click: the second to play from (G-PLAY-3).
    var onFlag: (Double) -> Void = { _ in }
    /// A click on the waveform: the second clicked.
    var onSeek: (Double) -> Void = { _ in }
    /// Zoom out (true) or fit the clip again (false): a view change only (R4).
    var onZoom: (Bool) -> Void = { _ in }
    var onPlayMore: () -> Void = {}
    var pinActions: TimelinePinsRow.Actions = .init()

    /// The pins' rows in whole-meeting mode; none while a clip shows (its pins are on the strip).
    private var lanes: Int { span == nil && !pins.isEmpty ? min(3, max(1, pinLanes)) : 0 }
    /// The timeline's height: each row of pins after the first adds one row's height, so the waveform keeps its own.
    private var fullHeight: CGFloat { height + CGFloat(max(0, lanes - 1)) * PinMark.laneHeight }

    var body: some View {
        let lanes = lanes
        let fullHeight = fullHeight
        // Under the pins' rows in whole-meeting mode; under the flag's head beside a clip.
        let waveY: CGFloat = span == nil ? 20 + CGFloat(max(1, lanes)) * PinMark.laneHeight : 26
        let waveHeight: CGFloat = span == nil ? height - 50 : height - 58
        return VStack(alignment: .leading, spacing: 4) {
            GeometryReader { proxy in
                let width = proxy.size.width
                // Every layer maps a second onto the whole width, so a mark, the playhead and a click agree.
                ZStack(alignment: .topLeading) {
                    TimelineRuler(view: view).frame(width: width).offset(y: 3)
                    if let span { shading(span, width: width) }
                    WaveformBars(peaks: peaks, peaksRange: peaksRange, view: view,
                                 clip: span.map { $0.startSec...max($0.startSec, $0.endSec) },
                                 asked: span.map { $0.fromSec...max($0.fromSec, $0.toSec) }, voices: voices)
                        .frame(width: width, height: waveHeight)
                        .offset(y: waveY)
                        .contentShape(Rectangle())
                        .onTapGesture(coordinateSpace: .local) { point in
                            onSeek(TimelineGeometry.sec(atX: point.x, in: view, width: width))
                        }
                        .accessibilityHidden(true)
                    TimelineGrid(view: view)
                        .frame(width: width, height: fullHeight - 16 - (span == nil ? 6 : 24))
                        .offset(y: 16)
                    if lanes > 0 {
                        TimelinePinsRow(pins: pins, view: view, actions: pinActions, lanes: lanes)
                            .frame(width: width, height: CGFloat(lanes) * PinMark.laneHeight)
                            .offset(y: 16)
                    }
                    if let span { flag(span, width: width) }
                    TimelinePlayhead(position: position, view: view)
                        .frame(width: width, height: fullHeight - 40)
                        .offset(y: 18)
                    if let span { padWords(span, width: width) }
                }
                .frame(width: width, height: fullHeight, alignment: .topLeading)
            }
            .frame(height: fullHeight)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            footer
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(span.map { "Timeline of \($0.label)" } ?? "Timeline of the meeting")
    }

    // The pad (the clip outside the asked span) shaded lightly, the asked span stronger, with a dashed end.
    private func shading(_ span: ZoomSpan, width: CGFloat) -> some View {
        let clipX = TimelineGeometry.x(span.startSec, in: view, width: width)
        let clipEnd = TimelineGeometry.x(span.endSec, in: view, width: width)
        let askX = TimelineGeometry.x(span.fromSec, in: view, width: width)
        let askEnd = TimelineGeometry.x(max(span.toSec, span.fromSec), in: view, width: width)
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color.accentColor.opacity(0.08))
                .frame(width: max(0, clipEnd - clipX), height: height - 44)
                .offset(x: clipX, y: 20)
            Rectangle().fill(Color.accentColor.opacity(0.18))
                .frame(width: max(0, askEnd - askX), height: height - 44)
                .overlay(alignment: .trailing) {
                    Rectangle().stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .foregroundStyle(Color.accentColor.opacity(0.6)).frame(width: 1)
                }
                .offset(x: askX, y: 20)
        }
        .allowsHitTesting(false)
    }

    // The flag stands on the boundary where the asked part begins (R46). A range question adds a tick at its end.
    private func flag(_ span: ZoomSpan, width: CGFloat) -> some View {
        let x = TimelineGeometry.x(span.fromSec, in: view, width: width)
        let endX = TimelineGeometry.x(span.toSec, in: view, width: width)
        return ZStack(alignment: .topLeading) {
            if span.isRange, span.toSec > span.fromSec {
                Rectangle().fill(Color.accentColor).frame(width: 2, height: 14)
                    .offset(x: endX - 1, y: height - 38)
                    .accessibilityHidden(true)
            }
            FlagMark(text: "\(MeetingsFormat.clock(span.fromSec)) · \(span.label)", lineHeight: height - 44,
                     accessibility: "Asked spot at \(MeetingsFormat.clock(span.spotSec)), \(span.label). Plays from there.") {
                onFlag(span.flagSeekTarget)
            }
            .offset(x: x - FlagMark.lineX, y: 20)
        }
    }

    private func padWords(_ span: ZoomSpan, width: CGFloat) -> some View {
        let before = max(0, span.fromSec - span.startSec)
        return HStack(spacing: 0) {
            Text(verbatim: before > 0 ? "\(MeetingsFormat.seconds(before.rounded())) before" : "")
                .frame(width: max(0, TimelineGeometry.x(span.fromSec, in: view, width: width) - TimelineGeometry.x(span.startSec, in: view, width: width)), alignment: .leading)
            Text(verbatim: span.isRange || span.toSec > span.fromSec
                 ? "asked span \(MeetingsFormat.clock(span.fromSec)) to \(MeetingsFormat.clock(span.toSec))"
                 : "asked spot \(MeetingsFormat.clock(span.spotSec))")
            Spacer(minLength: 8)
            Text(verbatim: "clip ends \(MeetingsFormat.clock(span.endSec))")
        }
        .font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
        .padding(.leading, TimelineGeometry.x(span.startSec, in: view, width: width) + 2)
        .padding(.trailing, 6)
        .frame(width: width, alignment: .leading)
        .offset(y: height - 18)
        .accessibilityHidden(true)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if offerMore {
                GhostButton("Play \(Int(moreSec)) s more", symbol: "forward.end",
                            tooltip: "Play on after this clip, as its own Moment",
                            identifier: "meetings.timeline.more", action: onPlayMore)
            }
            if !legend.isEmpty { VoiceLegendRow(voices: legend) }
            Spacer(minLength: 0)
            if lanes > 0 {
                PinLegend().font(.system(size: 10.5)).foregroundStyle(.secondary).accessibilityHidden(true)
            }
            if span != nil {
                GhostButton(zoomedOut ? "Fit clip" : "Zoom out", symbol: zoomedOut ? "arrow.down.right.and.arrow.up.left" : "minus.magnifyingglass",
                            tooltip: zoomedOut ? "Show the clip alone again; the sound goes on" : "Show more of the meeting around the clip; the sound goes on",
                            identifier: "meetings.timeline.zoom") { onZoom(!zoomedOut) }
            }
        }
    }
}

/// The asked-spot flag: a line on the boundary with its head, and a 22 pt hit area around the line (G-ROW-2). Its
/// frame is the hit area, 22 pt wide with the line at its centre: place it with `.offset(x: boundaryX - FlagMark.lineX)`.
struct FlagMark: View {
    /// Where the line sits inside the 22 pt hit area.
    static let hitWidth: CGFloat = 22
    static let lineX: CGFloat = 10

    let text: String
    let lineHeight: CGFloat
    let accessibility: String
    var compact: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topLeading) {
                Color.clear.frame(width: Self.hitWidth, height: max(22, lineHeight)).contentShape(Rectangle())
                Rectangle().fill(Color.accentColor).frame(width: 2, height: lineHeight)
                    .offset(x: Self.lineX)
                Text(verbatim: text.isEmpty ? "⚑" : "⚑ \(text)")
                    .font(.system(size: compact ? 9 : 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .padding(.horizontal, compact ? 4 : 6).padding(.vertical, compact ? 1 : 2)
                    .background(UnevenRoundedRectangle(bottomTrailingRadius: 4, topTrailingRadius: 4).fill(Color.accentColor))
                    .fixedSize()
                    .offset(x: Self.lineX)
            }
            .frame(width: Self.hitWidth, height: max(22, lineHeight), alignment: .topLeading)
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("Play from the asked spot, with its tone")
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("meetings.timeline.flag")
    }
}
