import SwiftUI

// MARK: - Pins on the timeline (R3, R5, R6, G-PLAY-5, G-PLAY-8, G-A11Y-1)

/// One review row on the timeline, in whole-meeting mode and on the whole-conversation strip.
struct TimelinePin: Identifiable, Equatable {
    enum State: Equatable {
        /// Waits for an answer.
        case open
        /// Confirmed.
        case done
        /// Rejected (or skipped): its own hue and glyph, as on the row (genesiscz.md 12a).
        case rejected
        /// A question for the reader.
        case question
        /// The row that plays now.
        case playing
    }

    /// The review row's id.
    let id: String
    let sec: Double
    /// The short text on the pin (R6): the row's label or a few words of what it asks.
    let text: String
    let state: State
    /// A filter hides the row in the list: the pin is drawn dimmed (G-PLAY-5).
    var dimmed: Bool = false

    /// The pin of a review row: the start of its first `when` part, its label as the text.
    init?(row: ReviewRow, playing: Bool = false, dimmed: Bool = false) {
        guard let sec = row.parts.lazy.compactMap({ part -> Double? in
            if case .when(let from, _, _) = part { return from.sec }
            return nil
        }).first ?? row.target.startSec else { return nil }
        self.init(id: row.id, sec: sec, text: TimelinePin.shortText(row.what),
                  state: playing ? .playing : row.isQuestion && row.isOpen ? .question : row.isOpen ? .open
                    : row.status == "rejected" ? .rejected : .done,
                  dimmed: dimmed)
    }

    init(id: String, sec: Double, text: String, state: State, dimmed: Bool = false) {
        self.id = id
        self.sec = sec
        self.text = text
        self.state = state
        self.dimmed = dimmed
    }

    /// At most `limit` characters, cut at a word.
    static func shortText(_ text: String, limit: Int = 28) -> String {
        guard text.count > limit else { return text }
        let cut = text.prefix(limit)
        let word = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return word.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The pin's glyph under `meetings.rows.stateLook`. In the hue-and-glyph look a suggestion waiting for an answer
    /// carries the sparkle its chip carries, a confirmed one the check and a rejected one the cross; the shade look keeps
    /// the older flags, with a rejected pin drawn as a decided one.
    func symbol(_ stateLook: MeetingsPreferences.Rows.StateLook) -> String {
        switch (state.shown(stateLook), stateLook) {
        case (.open, .hueAndGlyph): return "sparkles"
        case (.playing, .hueAndGlyph): return "play.fill"
        case (.open, .shade), (.playing, .shade): return "flag.fill"
        case (.done, _): return "checkmark"
        case (.rejected, _): return "xmark"
        case (.question, _): return "questionmark"
        }
    }

    /// The classic look's tint under `meetings.rows.stateLook`.
    func tint(_ stateLook: MeetingsPreferences.Rows.StateLook) -> Color {
        switch state.shown(stateLook) {
        case .open: return .accentColor
        case .done: return stateLook == .shade ? .secondary : KitHue.done.ink
        case .rejected: return KitHue.danger.ink
        case .question: return .purple
        case .playing: return .primary
        }
    }

    var stateWords: String {
        switch state {
        case .open: return "open"
        case .done: return "answered"
        case .rejected: return "rejected"
        case .question: return "question"
        case .playing: return "playing"
        }
    }
}

extension TimelinePin.State {
    /// The state as `meetings.rows.stateLook` draws it: the shade look has no rejected pin of its own.
    func shown(_ stateLook: MeetingsPreferences.Rows.StateLook) -> Self {
        stateLook == .shade && self == .rejected ? .done : self
    }

    /// The state's colour by its meaning, in a look: an open row is a suggestion (care in the shade look), a decided
    /// one is done, a rejected one is danger, a question asks, the playing one plays.
    func hue(_ stateLook: MeetingsPreferences.Rows.StateLook) -> KitHue {
        switch shown(stateLook) {
        case .open: return stateLook == .shade ? .care : .play
        case .done: return .done
        case .rejected: return .danger
        case .question: return .ask
        case .playing: return .play
        }
    }
}

/// Pins that sit closer than the merge gap drawn as one mark with a count (G-PLAY-8).
struct PinCluster: Identifiable, Equatable {
    let pins: [TimelinePin]
    /// The first pin's x, kept inside the drawable icon bounds.
    let x: CGFloat
    /// The free room to the next mark's x (for the short text); the rest of the width for the last mark.
    var room: CGFloat
    /// The row the mark stands on, 0 the top one (`laid`).
    var lane: Int = 0

    var id: String { pins.map(\.id).joined(separator: "+") }
    var isSingle: Bool { pins.count == 1 }
    /// A dense mark keeps one useful title beside its count, preferring the playing or unanswered item.
    var caption: String { (pins.first { $0.state == state } ?? pins.first)?.text ?? "" }
    /// The seconds the pins span.
    var range: ClosedRange<Double> { (pins.map(\.sec).min() ?? 0)...(pins.map(\.sec).max() ?? 0) }
    /// Dimmed only when every pin in it is.
    var dimmed: Bool { pins.allSatisfy(\.dimmed) }
    /// The strongest state in it: playing, then question, then open, then done.
    var state: TimelinePin.State {
        let order: [TimelinePin.State] = [.playing, .question, .open, .done, .rejected]
        return order.first { state in pins.contains { $0.state == state } } ?? .done
    }

    /// The view a click on a merged mark asks for: its pins' seconds with 10 % room each side, at least 10 s wide.
    static func expanded(_ range: ClosedRange<Double>) -> ClosedRange<Double> {
        let length = max(range.upperBound - range.lowerBound, 10)
        let middle = (range.lowerBound + range.upperBound) / 2
        let half = length * 0.6
        return max(0, middle - half)...(middle + half)
    }

    /// Whether a zoom to the mark's pins shows less than `view` does. False for pins at one second in a view that is
    /// short already: such a mark never came apart ("still 2 items but it never expands"), so it opens a list instead.
    func expands(in view: ClosedRange<Double>) -> Bool {
        let target = Self.expanded(range)
        return target.upperBound - target.lowerBound < (view.upperBound - view.lowerBound) * 0.85
    }

    private static func boundedX(_ second: Double, in range: ClosedRange<Double>, width: CGFloat) -> CGFloat {
        let inset = min(PinMark.iconWidth / 2, width / 2)
        return min(width - inset, max(inset, TimelineGeometry.x(second, in: range, width: width)))
    }

    /// Pins of a view on `lanes` rows: a pin stands on the first row whose last mark shows its whole text before it,
    /// else on the row whose last mark is farthest back when a mark still fits there (that mark's text is cut), and
    /// only when no row has `markWidth` of room it joins the first row's mark, which becomes a count. So pins that
    /// are close in time stand under each other with their texts, and a count is the last resort.
    static func laid(_ pins: [TimelinePin], in range: ClosedRange<Double>, width: CGFloat, lanes: Int,
                     markWidth: CGFloat = PinMark.markWidth,
                     wants: (TimelinePin) -> CGFloat = PinMark.wantedWidth) -> [PinCluster] {
        guard width > 0 else { return [] }
        let placed = pins.filter { range.contains($0.sec) }
            .map { (pin: $0, x: boundedX($0.sec, in: range, width: width)) }
            .sorted { $0.x < $1.x }
        var marks: [(pins: [TimelinePin], x: CGFloat, lane: Int, want: CGFloat)] = []
        // The index of each row's last mark.
        var last = [Int?](repeating: nil, count: max(1, lanes))
        for item in placed {
            var lane: Int?
            var farthest: (row: Int, x: CGFloat)?
            for (row, index) in last.enumerated() {
                guard let index else {
                    lane = row
                    break
                }
                if marks[index].x + marks[index].want <= item.x {
                    lane = row
                    break
                }
                if farthest.map({ marks[index].x < $0.x }) ?? true { farthest = (row, marks[index].x) }
            }
            if lane == nil, let farthest, item.x - farthest.x >= markWidth { lane = farthest.row }
            if let lane {
                last[lane] = marks.count
                marks.append((pins: [item.pin], x: item.x, lane: lane, want: max(markWidth, wants(item.pin))))
            } else if let join = last[0] {
                marks[join].pins.append(item.pin)
                marks[join].want = markWidth
            }
        }
        return marks.enumerated().map { index, mark in
            let next = marks[(index + 1)...].first { $0.lane == mark.lane }?.x ?? width
            return PinCluster(pins: mark.pins, x: mark.x, room: max(0, next - mark.x), lane: mark.lane)
        }
    }

    /// Pins of a view of `range` that is `width` wide, merged so that no two marks overlap: a pin joins the mark before
    /// it while it sits within `markWidth` points of that mark's first pin, and a mark never comes closer than
    /// `markWidth` to the one before it. A mark so stays within `markWidth` of its pins, and a dense stretch reads as a
    /// row of counts, not as one count for the whole meeting. Pins outside the view are left out.
    ///
    /// The first rule merged pins closer than 6 pt. A mark is 16 pt wide, so marks 6 to 16 pt apart drew over each
    /// other on a long meeting's strip.
    static func clusters(_ pins: [TimelinePin], in range: ClosedRange<Double>, width: CGFloat,
                         markWidth: CGFloat = PinMark.markWidth) -> [PinCluster] {
        guard width > 0 else { return [] }
        let placed = pins.filter { range.contains($0.sec) }
            .map { (pin: $0, x: boundedX($0.sec, in: range, width: width)) }
            .sorted { $0.x < $1.x }
        var groups: [[(pin: TimelinePin, x: CGFloat)]] = []
        for item in placed {
            if let first = groups.last?.first, item.x - first.x < markWidth {
                groups[groups.count - 1].append(item)
            } else {
                groups.append([item])
            }
        }
        let marks = groups.compactMap { group -> (pins: [TimelinePin], x: CGFloat)? in
            guard let first = group.first else { return nil }
            return (pins: group.map(\.pin), x: first.x)
        }
        return marks.enumerated().map { index, mark in
            let next = index + 1 < marks.count ? marks[index + 1].x : width
            return PinCluster(pins: mark.pins, x: mark.x, room: max(0, next - mark.x))
        }
    }
}

/// The pins over a waveform, on one row or on `lanes` rows. A click on a pin selects its row; a click on a merged
/// mark zooms to its pins, or lists them when a zoom would not take them apart; hovering or focusing a pin reports it
/// for the hover card (PinCard).
struct TimelinePinsRow: View {
    struct Actions {
        /// A single pin: select the row, switch to its tab, scroll to it (R3, G-PLAY-5, G-PLAY-6).
        var select: (String) -> Void = { _ in }
        /// A merged mark: show its seconds (a view change).
        var expand: (ClosedRange<Double>) -> Void = { _ in }
        /// The pointer or the keyboard focus is on a pin (its row id), or left it (nil). PinCardPresenter takes this.
        var hover: (String?) -> Void = { _ in }
    }

    let pins: [TimelinePin]
    let view: ClosedRange<Double>
    var actions: Actions = .init()
    /// Show the short text beside a pin when there is room (R6).
    var showsText: Bool = true
    /// Rows for pins that are close in time (`PinCluster.laid`); 1 merges them into counts on one row.
    var lanes: Int = 1
    /// How suggested, confirmed and rejected pins differ (`meetings.rows.stateLook`), read once here for every mark.
    @AppStorage(MeetingsPreferences.Rows.stateLook.key) private var stateLook = MeetingsPreferences.Rows.stateLook.defaultValue

    var body: some View {
        GeometryReader { proxy in
            let captionRoom: CGFloat = showsText ? 72 : PinMark.markWidth
            let clusters = lanes > 1 ? PinCluster.laid(pins, in: view, width: proxy.size.width, lanes: lanes, markWidth: captionRoom)
                : PinCluster.clusters(pins, in: view, width: proxy.size.width, markWidth: captionRoom)
            ZStack(alignment: .topLeading) {
                ForEach(clusters) { cluster in
                    PinMark(cluster: cluster, showsText: showsText, expands: cluster.expands(in: view), actions: actions, stateLook: stateLook)
                        .offset(x: max(0, cluster.x - PinMark.iconWidth / 2), y: CGFloat(cluster.lane) * PinMark.laneHeight)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pins")
    }
}

/// One pin, or one merged mark with its count.
struct PinMark: View {
    static let iconWidth: CGFloat = 16
    /// The room one mark takes on its lane: the icon, or a two-digit count in its capsule, and a gap.
    static let markWidth: CGFloat = 20
    /// The height of one row of marks.
    static let laneHeight: CGFloat = 18
    /// The widest text a mark shows.
    static let maxTextWidth: CGFloat = 160

    /// The room a pin's mark takes with its whole text: the icon, the text at about 5.6 pt a letter, and a gap.
    static func wantedWidth(_ pin: TimelinePin) -> CGFloat {
        iconWidth + 3 + min(maxTextWidth, CGFloat(pin.text.count) * 5.6) + 10
    }

    let cluster: PinCluster
    let showsText: Bool
    /// A click on a merged mark zooms to its pins; false opens a list of them (a zoom would show the same marks).
    var expands: Bool = true
    let actions: TimelinePinsRow.Actions
    /// `meetings.rows.stateLook`, read once by the pins row.
    var stateLook = MeetingsPreferences.Rows.stateLook.defaultValue
    @FocusState private var focused: Bool
    @Environment(\.kitLook) private var look

    var body: some View {
        mark
        .opacity(cluster.dimmed ? 0.35 : 1)
        .fixedSize()
        .onHover { inside in
            if inside, cluster.isSingle, let pin = cluster.pins.first { actions.hover(pin.id) } else if !inside { actions.hover(nil) }
        }
        // The keyboard focus opens the card too (G-CARD-1).
        .focused($focused)
        .onChange(of: focused) { _, now in
            if now, cluster.isSingle, let pin = cluster.pins.first { actions.hover(pin.id) } else if !now { actions.hover(nil) }
        }
        // lint-rules-ignore: short list (the marks of the button below: a lane holds at most its width / 20 of them, and each keeps its tooltip, because a merged mark says in it what a click does)
        .instantTooltip(tooltip)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("meetings.timeline.pin")
    }

    /// A pin or a mark that zooms is a button; a mark no zoom takes apart is a menu of its rows.
    @ViewBuilder
    private var mark: some View {
        if cluster.isSingle || expands {
            // lint-rules-ignore: short list (marks keep 20 pt apart, so a lane holds at most its width / 20 of them; each stays a focusable button, because the keyboard focus opens its card, G-CARD-1)
            Button {
                if cluster.isSingle, let pin = cluster.pins.first { actions.select(pin.id) } else { actions.expand(cluster.range) }
            } label: { label }
            .buttonStyle(.genHoverPlain())
        } else {
            MenuButton(items: {
                cluster.pins.map { pin in
                    .action("\(MeetingsFormat.clock(pin.sec)) · \(pin.text) (\(pin.stateWords))") { actions.select(pin.id) }
                }
            }) { label }
        }
    }

    private var label: some View {
        HStack(spacing: 3) {
            if cluster.isSingle {
                glyph(cluster.pins[0].symbol(stateLook))
            } else {
                Text(verbatim: "\(cluster.pins.count)")
                    .font(.system(size: 9, weight: .bold).monospacedDigit())
                    // The playing group's capsule is the text colour (white in the dark look), so its count
                    // takes the window's colour; white on white showed an empty capsule.
                    .foregroundStyle(look == .classic && cluster.state == .playing ? Color(nsColor: .windowBackgroundColor) : .white)
                    .padding(.horizontal, 4)
                    .lineLimit(1).minimumScaleFactor(0.5)
                    .frame(width: Self.iconWidth, height: 14)
                    .background(Capsule().fill(fill))
            }
            if showsText, cluster.room > 40 {
                Text(verbatim: cluster.caption)
                    .font(.system(size: 10, weight: look == .classic ? .regular : .medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: min(Self.maxTextWidth, cluster.room - Self.iconWidth - 8), alignment: .leading)
            }
        }
        .foregroundStyle(tint)
        .frame(minHeight: Self.laneHeight)
        .contentShape(Rectangle())
    }

    /// One pin's glyph: tinted in the classic look, white on a disc of the state's hue in a look.
    @ViewBuilder
    private func glyph(_ symbol: String) -> some View {
        if look == .classic {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).frame(width: Self.iconWidth)
        } else {
            Image(systemName: symbol).font(.system(size: 8, weight: .heavy)).foregroundStyle(.white)
                .frame(width: 14, height: 14)
                .background(Circle().fill(fill))
                .frame(width: Self.iconWidth)
        }
    }

    /// Text and glyph: the classic tint, or the ink of the state's hue.
    private var tint: Color {
        look == .classic ? TimelinePin(id: "", sec: 0, text: "", state: cluster.state).tint(stateLook) : cluster.state.hue(stateLook).ink
    }

    /// A count's capsule and a pin's disc.
    private var fill: Color { look == .classic ? tint : cluster.state.hue(stateLook).solid }

    private var tooltip: String {
        if cluster.isSingle, let pin = cluster.pins.first { return "\(MeetingsFormat.clock(pin.sec)) · \(pin.text)" }
        let between = "\(cluster.pins.count) items between \(MeetingsFormat.clock(cluster.range.lowerBound)) and \(MeetingsFormat.clock(cluster.range.upperBound))"
        return expands ? "\(between): click to zoom in" : "\(between): click to pick one"
    }

    private var accessibility: String {
        if cluster.isSingle, let pin = cluster.pins.first {
            return "\(pin.text), \(pin.stateWords), at \(MeetingsFormat.clock(pin.sec))\(pin.dimmed ? ", hidden by the filter" : "")"
        }
        return "\(cluster.pins.count) items from \(MeetingsFormat.clock(cluster.range.lowerBound)) to \(MeetingsFormat.clock(cluster.range.upperBound))"
    }
}
