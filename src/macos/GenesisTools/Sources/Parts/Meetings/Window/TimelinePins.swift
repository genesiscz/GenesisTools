import SwiftUI

// MARK: - Pins on the timeline (R3, R5, R6, G-PLAY-5, G-PLAY-8, G-A11Y-1)

/// One review row on the timeline, in whole-meeting mode and on the whole-conversation strip.
struct TimelinePin: Identifiable, Equatable {
    enum State: Equatable {
        /// Waits for an answer.
        case open
        /// Decided.
        case done
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
                  state: playing ? .playing : row.isQuestion && row.isOpen ? .question : row.isOpen ? .open : .done,
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

    var symbol: String {
        switch state {
        case .open, .playing: return "flag.fill"
        case .done: return "checkmark"
        case .question: return "questionmark"
        }
    }

    var tint: Color {
        switch state {
        case .open: return .accentColor
        case .done: return .secondary
        case .question: return .purple
        case .playing: return .primary
        }
    }

    var stateWords: String {
        switch state {
        case .open: return "open"
        case .done: return "answered"
        case .question: return "question"
        case .playing: return "playing"
        }
    }
}

/// Pins that sit closer than the merge gap drawn as one mark with a count (G-PLAY-8).
struct PinCluster: Identifiable, Equatable {
    let pins: [TimelinePin]
    /// The x of the mark: the middle of its pins' x.
    let x: CGFloat
    /// The free room to the next mark's x (for the short text); the rest of the width for the last mark.
    var room: CGFloat

    var id: String { pins.map(\.id).joined(separator: "+") }
    var isSingle: Bool { pins.count == 1 }
    /// The seconds the pins span.
    var range: ClosedRange<Double> { (pins.map(\.sec).min() ?? 0)...(pins.map(\.sec).max() ?? 0) }
    /// Dimmed only when every pin in it is.
    var dimmed: Bool { pins.allSatisfy(\.dimmed) }
    /// The strongest state in it: playing, then question, then open, then done.
    var state: TimelinePin.State {
        let order: [TimelinePin.State] = [.playing, .question, .open, .done]
        return order.first { state in pins.contains { $0.state == state } } ?? .done
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
        let placed = pins.filter { range.contains($0.sec) }
            .map { (pin: $0, x: TimelineGeometry.x($0.sec, in: range, width: width)) }
            .sorted { $0.x < $1.x }
        var groups: [[(pin: TimelinePin, x: CGFloat)]] = []
        for item in placed {
            if let first = groups.last?.first, item.x - first.x < markWidth {
                groups[groups.count - 1].append(item)
            } else {
                groups.append([item])
            }
        }
        var marks: [(pins: [TimelinePin], x: CGFloat)] = []
        for group in groups {
            let middle = ((group.first?.x ?? 0) + (group.last?.x ?? 0)) / 2
            marks.append((pins: group.map(\.pin), x: marks.last.map { max(middle, $0.x + markWidth) } ?? middle))
        }
        return marks.enumerated().map { index, mark in
            let next = index + 1 < marks.count ? marks[index + 1].x : width
            return PinCluster(pins: mark.pins, x: mark.x, room: max(0, next - mark.x))
        }
    }
}

/// The row of pins over a waveform. A click on a pin selects its row; a click on a merged mark zooms to its pins;
/// hovering or focusing a pin reports it for the hover card (PinCard).
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

    var body: some View {
        GeometryReader { proxy in
            let clusters = PinCluster.clusters(pins, in: view, width: proxy.size.width)
            ZStack(alignment: .topLeading) {
                ForEach(clusters) { cluster in
                    PinMark(cluster: cluster, showsText: showsText, actions: actions)
                        .offset(x: cluster.x - PinMark.iconWidth / 2)
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

    let cluster: PinCluster
    let showsText: Bool
    let actions: TimelinePinsRow.Actions
    @FocusState private var focused: Bool

    var body: some View {
        // lint-rules-ignore: short list (marks keep 20 pt apart, so a lane holds at most its width / 20 of them; each stays a focusable button, because the keyboard focus opens its card, G-CARD-1)
        Button {
            if cluster.isSingle, let pin = cluster.pins.first { actions.select(pin.id) } else { actions.expand(cluster.range) }
        } label: {
            HStack(spacing: 3) {
                if cluster.isSingle {
                    Image(systemName: cluster.pins[0].symbol)
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: Self.iconWidth)
                } else {
                    Text(verbatim: "\(cluster.pins.count)")
                        .font(.system(size: 9, weight: .bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: Self.iconWidth, minHeight: 14)
                        .background(Capsule().fill(tint))
                }
                if showsText, cluster.isSingle, cluster.room > 40 {
                    Text(verbatim: cluster.pins[0].text)
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: min(160, cluster.room - Self.iconWidth - 8), alignment: .leading)
                }
            }
            .foregroundStyle(tint)
            .frame(minHeight: 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
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
        .instantTooltip(tooltip)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("meetings.timeline.pin")
    }

    private var tint: Color { TimelinePin(id: "", sec: 0, text: "", state: cluster.state).tint }

    private var tooltip: String {
        if cluster.isSingle, let pin = cluster.pins.first { return "\(MeetingsFormat.clock(pin.sec)) · \(pin.text)" }
        return "\(cluster.pins.count) items between \(MeetingsFormat.clock(cluster.range.lowerBound)) and \(MeetingsFormat.clock(cluster.range.upperBound)): click to zoom in"
    }

    private var accessibility: String {
        if cluster.isSingle, let pin = cluster.pins.first {
            return "\(pin.text), \(pin.stateWords), at \(MeetingsFormat.clock(pin.sec))\(pin.dimmed ? ", hidden by the filter" : "")"
        }
        return "\(cluster.pins.count) items from \(MeetingsFormat.clock(cluster.range.lowerBound)) to \(MeetingsFormat.clock(cluster.range.upperBound))"
    }
}
