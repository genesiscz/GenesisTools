import SwiftUI

// MARK: - Talk time per speaker (R20, R21, R40, G-SPK-6, G-SPK-7, G-SPK-8)
//
// Presentational only. b-swift-timeline puts `SpeakerTalkTimeLanes` above the speaker rows of the Speakers tab and
// feeds it `meeting.speakers`; a click plays a span through the Moment player or zooms the timeline.

/// An open question at a time, drawn as a "?" banner above the lanes.
struct TalkTimeQuestion: Equatable, Hashable, Identifiable {
    let id: String
    let atSec: Double
    /// A short name ("Q12"); nil draws "?" alone.
    var label: String? = nil
}

/// A block of a lane in points: one span, or neighbours joined because they are too thin to see (G-SPK-8).
struct TalkTimeBlock: Equatable, Hashable {
    let fromSec: Double
    let toSec: Double
    let x: CGFloat
    let width: CGFloat
    /// How many spans the block holds (1: one stretch).
    let spans: Int
    /// The joined spans' starts after the first, in points: the turn ticks a joined block keeps.
    let ticks: [CGFloat]

    var isJoined: Bool { spans > 1 }
}

/// A banner in points: one question, or several closer than a banner's width merged into "? ×N".
struct TalkTimeBanner: Equatable, Hashable {
    let x: CGFloat
    let ids: [String]
    let text: String
    let atSec: Double
}

enum TalkTimeLayout {
    /// The lane's blocks at `width` points. A span closer than `minWidth` to the block before it (a thin block counts
    /// as `minWidth` wide) joins that block, so short turns stay visible ("Blocks shorter than 2 px are joined", the
    /// sketch); a lone thin span draws at `minWidth`.
    static func blocks(_ spans: [MeetingsAPI.MeetingSpeakers.Span], durationSec: Double, width: CGFloat,
                       minWidth: CGFloat = 2) -> [TalkTimeBlock] {
        guard durationSec > 0, width > 0 else { return [] }
        let scale = width / CGFloat(durationSec)
        var result: [TalkTimeBlock] = []
        for span in spans.sorted(by: { $0.fromSec < $1.fromSec }) {
            let x = CGFloat(span.fromSec) * scale
            let end = CGFloat(max(span.toSec, span.fromSec)) * scale
            if let last = result.last, x - (last.x + max(last.width, minWidth)) < minWidth {
                let newEnd = max(last.x + last.width, end)
                result[result.count - 1] = TalkTimeBlock(
                    fromSec: last.fromSec, toSec: max(last.toSec, span.toSec), x: last.x, width: newEnd - last.x,
                    spans: last.spans + 1, ticks: last.ticks + [x])
            } else {
                result.append(TalkTimeBlock(fromSec: span.fromSec, toSec: span.toSec, x: x, width: end - x, spans: 1, ticks: []))
            }
        }
        // A lone thin block still shows at the minimum width.
        return result.map { block in
            block.width >= minWidth ? block : TalkTimeBlock(fromSec: block.fromSec, toSec: block.toSec, x: block.x,
                                                            width: minWidth, spans: block.spans, ticks: block.ticks)
        }
    }

    /// The turn ticks a joined block draws: each at least `gap` points from the tick before it and from the block's
    /// ends. A block that joins hundreds of short turns drew a tick every point or two, which read as a barcode.
    static func shownTicks(_ block: TalkTimeBlock, gap: CGFloat = 6) -> [CGFloat] {
        var shown: [CGFloat] = []
        var last = block.x
        for tick in block.ticks where tick - last >= gap && block.x + block.width - tick >= gap {
            shown.append(tick)
            last = tick
        }
        return shown
    }

    /// The room a banner with a label takes ("? Q12" in bold 10.5 pt with its padding, and a gap).
    static let bannerWidth: CGFloat = 46

    /// The banners at `width` points; questions closer than `mergeWidth` merge into one "? ×N" banner ("? 2" read as question 2). The merge
    /// distance is a banner's own width: at 22 pt two labelled banners 22 to 45 pt apart drew over each other.
    static func banners(_ questions: [TalkTimeQuestion], durationSec: Double, width: CGFloat,
                        mergeWidth: CGFloat = TalkTimeLayout.bannerWidth) -> [TalkTimeBanner] {
        guard durationSec > 0, width > 0 else { return [] }
        let scale = width / CGFloat(durationSec)
        var groups: [[TalkTimeQuestion]] = []
        for question in questions.sorted(by: { $0.atSec < $1.atSec }) {
            if let first = groups.last?.first, CGFloat(question.atSec - first.atSec) * scale < mergeWidth {
                groups[groups.count - 1].append(question)
            } else {
                groups.append([question])
            }
        }
        return groups.map { group in
            let text = group.count == 1 ? (group[0].label.map { "? \($0)" } ?? "?") : "? ×\(group.count)"
            return TalkTimeBanner(x: CGFloat(group[0].atSec) * scale, ids: group.map(\.id), text: text, atSec: group[0].atSec)
        }
    }

    /// The block under `x`, with a few points of slack so a 2 pt block is still hit.
    static func block(at x: CGFloat, in blocks: [TalkTimeBlock], slack: CGFloat = 3) -> TalkTimeBlock? {
        blocks.min { distance(x, $0) < distance(x, $1) }.flatMap { distance(x, $0) <= slack ? $0 : nil }
    }

    private static func distance(_ x: CGFloat, _ block: TalkTimeBlock) -> CGFloat {
        if x < block.x { return block.x - x }
        if x > block.x + block.width { return x - (block.x + block.width) }
        return 0
    }
}

/// The talk-time block above the speaker rows: one lane per speaker (name, lane, share), "?" banners for the open
/// questions, and a ruler. Blocks are neutral; the accent marks only state (G-SPK-6): the spans in `activeRange` (what
/// plays) and the lane of `selectedLabel`.
struct SpeakerTalkTimeLanes: View {
    let speakers: [MeetingsAPI.MeetingSpeakers.Speaker]
    let durationSec: Double
    /// False when no line has a time (G-SPK-7): no lanes, one explanatory line.
    let timed: Bool
    var questions: [TalkTimeQuestion] = []
    /// What plays now, on the meeting clock; its spans draw in the accent.
    var activeRange: ClosedRange<Double>? = nil
    var selectedLabel: String? = nil
    /// Shows the "?" banners (the sketch's "Show open questions"). The plan's pick: on.
    var showsQuestions = true
    /// The renamed name per label, as the rows show it.
    var names: [String: String] = [:]
    /// A click on one stretch: play only that span (R20).
    let playSpan: (Double, Double) -> Void
    /// A click on a joined block: zoom the timeline to it (G-SPK-8).
    let zoom: (Double, Double) -> Void
    /// A click on a banner: the question ids under it.
    var openQuestion: ([String]) -> Void = { _ in }

    static let nameWidth: CGFloat = 170
    /// "50 % · 1 h 02 min" in 11 pt monospaced digits on one line (92 pt wrapped it in two).
    static let shareWidth: CGFloat = 124
    static let laneHeight: CGFloat = 30
    /// Below this width the names and the shares narrow (the share shows the percent only), so the lanes keep about half
    /// the width: at the window's smallest size the detail column is about 440 pt, and the full columns left the lanes
    /// 30 pt.
    static let compactWidth: CGFloat = 620
    static let compactNameWidth: CGFloat = 112
    static let compactShareWidth: CGFloat = 40
    /// The room an end label of the ruler takes ("2:26:10" in 10 pt monospaced digits, with a gap).
    static let rulerEndRoom: CGFloat = 80

    @State private var compact = false

    var body: some View {
        if !timed {
            Label("This transcript has no times, so the talk time cannot be drawn. The rows below show each speaker's turns and words.",
                  systemImage: "clock.badge.questionmark")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .padding(.vertical, 8)
        } else if speakers.isEmpty || durationSec <= 0 {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: 0)
                    .onGeometryChange(for: Bool.self, of: { $0.size.width < Self.compactWidth }) { compact = $0 }
                if showsQuestions && !questions.isEmpty {
                    row(name: Text("Open questions").font(.system(size: 11)).foregroundStyle(.secondary)) { width in
                        bannerLane(width: width).frameProbe("meetings.lanes.banners")
                    } share: { EmptyView() }
                    .frame(height: 26)
                }
                ForEach(sortedSpeakers) { speaker in
                    row(name: nameLabel(speaker)) { width in
                        lane(speaker, width: width).frameProbe("meetings.lanes.lane")
                    } share: {
                        Text(verbatim: shareText(speaker))
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .frame(height: Self.laneHeight)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(accessibilityText(speaker))
                    .accessibilityAction(named: "Play the first stretch") {
                        if let first = speaker.talkSpans.first { playSpan(first.fromSec, first.toSec) }
                    }
                }
                row(name: EmptyView()) { _ in ruler.frameProbe("meetings.lanes.ruler") } share: { EmptyView() }
                    .frame(height: 16)
            }
        }
    }

    private var sortedSpeakers: [MeetingsAPI.MeetingSpeakers.Speaker] {
        speakers.sorted { $0.spokenSec > $1.spokenSec }
    }

    private func row<Name: View, Lane: View, Share: View>(name: Name, @ViewBuilder lane: @escaping (CGFloat) -> Lane,
                                                         @ViewBuilder share: () -> Share) -> some View {
        // Each side column is a stack of its own: a width on an empty name or share is a width on nothing, so the row
        // of the questions and the row of the ruler had a wider lane than the speakers, and neither a banner nor a
        // clock time stood over the second it names.
        HStack(spacing: 12) {
            ZStack(alignment: .leading) { name }
                .frame(width: compact ? Self.compactNameWidth : Self.nameWidth, alignment: .leading)
            GeometryReader { proxy in lane(proxy.size.width) }
            ZStack(alignment: .trailing) { share() }
                .frame(width: compact ? Self.compactShareWidth : Self.shareWidth, alignment: .trailing)
        }
    }

    private func nameLabel(_ speaker: MeetingsAPI.MeetingSpeakers.Speaker) -> some View {
        HStack(spacing: 8) {
            TranscriptAvatar(speaker: displayName(speaker), size: 22)
            Text(verbatim: displayName(speaker)).font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
        }
    }

    private func displayName(_ speaker: MeetingsAPI.MeetingSpeakers.Speaker) -> String {
        names[speaker.label] ?? (speaker.label.isEmpty ? "Unknown voice" : speaker.label)
    }

    private func lane(_ speaker: MeetingsAPI.MeetingSpeakers.Speaker, width: CGFloat) -> some View {
        // The turns, not the spans: a span joins turns up to two minutes apart, so two people who took turns for
        // 43 seconds each drew as one bar over the whole meeting.
        let blocks = TalkTimeLayout.blocks(speaker.talkSpans, durationSec: durationSec, width: width)
        let selected = speaker.label == selectedLabel
        let active = activeRange
        return Canvas { context, size in
            let track = Path(roundedRect: CGRect(x: 0, y: (size.height - 10) / 2, width: size.width, height: 10), cornerRadius: 5)
            context.fill(track, with: .color(Color.secondary.opacity(selected ? 0.22 : 0.12)))
            for block in blocks {
                let rect = CGRect(x: block.x, y: (size.height - 10) / 2, width: block.width, height: 10)
                let isActive = active.map { $0.overlaps(block.fromSec...block.toSec) } ?? false
                let color: Color = isActive ? .accentColor : Color.secondary.opacity(selected ? 0.75 : 0.5)
                context.fill(Path(roundedRect: rect, cornerRadius: 2.5), with: .color(color))
                for tick in TalkTimeLayout.shownTicks(block) {
                    let line = Path(CGRect(x: tick, y: rect.minY + 1.5, width: 1, height: rect.height - 3))
                    // Quiet: at 0.7 the ticks of a long meeting drew over the turns they divide.
                    context.fill(line, with: .color(Color(nsColor: .windowBackgroundColor).opacity(0.4)))
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .local) { location in
            guard let block = TalkTimeLayout.block(at: location.x, in: blocks) else { return }
            if block.isJoined { zoom(block.fromSec, block.toSec) } else { playSpan(block.fromSec, block.toSec) }
        }
        .instantTooltip("A click plays one stretch; a joined block (with ticks) zooms the timeline to it")
    }

    private func bannerLane(width: CGFloat) -> some View {
        let banners = TalkTimeLayout.banners(questions, durationSec: durationSec, width: width)
        return ZStack(alignment: .topLeading) {
            ForEach(banners, id: \.self) { banner in
                Button { openQuestion(banner.ids) } label: {
                    VStack(spacing: 0) {
                        Text(verbatim: banner.text)
                            .font(.system(size: 10.5, weight: .bold))
                            .foregroundStyle(Color.white)
                            .padding(.horizontal, 5).frame(height: 16)
                            .background(RoundedRectangle(cornerRadius: 4).fill(Color.purple))
                        Rectangle().fill(Color.purple.opacity(0.5)).frame(width: 1, height: 8)
                    }
                    .frame(minWidth: 22, minHeight: 24)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .fixedSize()
                .position(x: banner.x, y: 12)
                .instantTooltip(bannerText(banner))
                .accessibilityLabel(bannerText(banner))
            }
        }
        .frame(width: width, height: 26, alignment: .topLeading)
    }

    private func bannerText(_ banner: TalkTimeBanner) -> String {
        banner.ids.count == 1 ? "Open question at \(MeetingsFormat.clock(banner.atSec))"
            : "\(banner.ids.count) open questions from \(MeetingsFormat.clock(banner.atSec))"
    }

    private var ruler: some View {
        GeometryReader { proxy in
            let marks = Self.rulerMarks(durationSec: durationSec)
            // A mark too close to an end label leaves out: at the narrowest lanes "2:00:00" overlapped "2:26:10".
            let inner = marks.dropFirst().dropLast().filter { sec in
                let x = CGFloat(sec / durationSec) * proxy.size.width
                return x > Self.rulerEndRoom && x < proxy.size.width - Self.rulerEndRoom
            }
            ZStack(alignment: .topLeading) {
                ForEach(inner, id: \.self) { sec in
                    rulerText(sec).position(x: CGFloat(sec / durationSec) * proxy.size.width, y: 7)
                }
                HStack {
                    rulerText(0)
                    Spacer()
                    rulerText(durationSec)
                }
                .frame(width: proxy.size.width)
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .accessibilityHidden(true)
    }

    private func rulerText(_ sec: Double) -> some View {
        Text(verbatim: MeetingsFormat.clock(sec))
            .font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            .fixedSize()
    }

    /// Ruler marks at a round step that gives four to seven marks, plus the end.
    static func rulerMarks(durationSec: Double) -> [Double] {
        guard durationSec > 0 else { return [] }
        let steps: [Double] = [10, 30, 60, 120, 300, 600, 900, 1800, 3600]
        let step = steps.first { durationSec / $0 <= 6 } ?? 7200
        var marks = Array(stride(from: 0, to: durationSec - step * 0.4, by: step))
        marks.append(durationSec)
        return marks
    }

    private func shareText(_ speaker: MeetingsAPI.MeetingSpeakers.Speaker, full: Bool = false) -> String {
        let total = speakers.reduce(0) { $0 + $1.spokenSec }
        let share = total > 0 ? Int((speaker.spokenSec / total * 100).rounded()) : 0
        if compact, !full { return "\(share) %" }
        return "\(share) % · \(MeetingsFormat.length(speaker.spokenSec) ?? "0 s")"
    }

    private func accessibilityText(_ speaker: MeetingsAPI.MeetingSpeakers.Speaker) -> String {
        "\(displayName(speaker)), \(shareText(speaker, full: true)), \(Plural.count(speaker.turns, "turn")), \(Plural.count(speaker.talkSpans.count, "stretch", "stretches"))"
    }
}
