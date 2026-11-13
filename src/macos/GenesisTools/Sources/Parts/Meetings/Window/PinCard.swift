import SwiftUI

// MARK: - The pin's hover card (R5, R37, G-CARD-1)

/// The whole context of one review row, large enough that nothing is cut to one line (R37): its label and time, what
/// it asks, the quote, what it settles, why, the answer choices with their confidence (R49), and "Show source" for each
/// typed source (R5). Presentational: every action is a closure.
struct PinCard: View {
    let row: ReviewRow
    var width: CGFloat = 380
    /// Play the row's Moment.
    var onPlay: () -> Void = {}
    /// Select the row in the list (and switch to its tab).
    var onSelect: () -> Void = {}
    /// Open a typed source: the document at its line, the commit, the work item, the URL, the transcript line.
    var onShowSource: (RowSource) -> Void = { _ in }
    /// The words for a row this one settles ("Speaker range 1:45:15–1:53:22"), by its id; nil when it is not known.
    var reference: (String) -> String? = { _ in nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Text(verbatim: ReviewRowView.title(row))
                .font(.system(size: 14, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            if !row.isOpen {
                // How it was decided stands under the title: at the card's end, in small grey text under five
                // choices, a decided row read as an open one.
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: row.status == "confirmed" ? "checkmark.circle.fill" : "xmark.circle")
                        .foregroundStyle(row.status == "confirmed" ? KitPalette.added : KitPalette.faint)
                        .accessibilityHidden(true)
                    if let answer = ReviewRowView.foldedAnswer(row) {
                        Text(verbatim: "→ \(answer)").font(.system(size: 12.5, weight: .semibold))
                    }
                    // The row's own words ("Confirmed by you: …"): the journal's action name ("Answer by you") was
                    // the data talking.
                    Text(verbatim: ReviewRowView.decidedWords(row)).font(.system(size: 11.5)).foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(row.parts.enumerated()), id: \.offset) { _, part in
                partView(part)
            }
            if !Self.shownChoices(row).isEmpty { choices }
            if !shownSources.isEmpty { sources }
        }
        .padding(14)
        .frame(width: width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(row.label): \(row.what)")
        .accessibilityIdentifier("meetings.timeline.card")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Badge(row.label, color: row.isQuestion ? .purple : .accentColor, monospaced: true)
            Text(verbatim: ReviewRowView.kindWord(row.kind)).font(.system(size: 11)).foregroundStyle(.secondary)
            if let time = whenText {
                Text(verbatim: time).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            if let confidence = row.confidence, let words = MeetingsWords.confidence(confidence) {
                Text(verbatim: words)
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityLabel("Confidence \(Int((confidence * 100).rounded())) percent")
            }
            Spacer(minLength: 8)
            IconButton(systemName: "play.fill", tooltip: "Play this item's Moment", action: onPlay)
                .accessibilityIdentifier("meetings.timeline.card.play")
            IconButton(systemName: "list.bullet.indent", tooltip: "Show this item in the list", action: onSelect)
                .accessibilityIdentifier("meetings.timeline.card.select")
        }
    }

    private var whenText: String? {
        for part in row.parts {
            if case .when(let from, let to, _) = part { return to.map { "\(from.text) to \($0.text)" } ?? from.text }
        }
        return nil
    }

    @ViewBuilder
    private func partView(_ part: RowPart) -> some View {
        switch part {
        case .who(let text):
            if row.isQuestion || !ReviewRowView.whoRepeatsTitle(text, title: row.what, when: row.whenText) { line("Who", text) }
        case .said(let text, let speaker, _):
            VStack(alignment: .leading, spacing: 2) {
                if let speaker { Text(verbatim: speaker).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary) }
                Text(verbatim: text).italic()
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 9)
            .overlay(alignment: .leading) { Rectangle().fill(Color.purple.opacity(0.6)).frame(width: 2) }
        case .when:
            EmptyView()
        case .asks(let pieces):
            // A question's title is what it asks: the same sentence again under "Asks" said it twice.
            if !row.isQuestion { line("Asks", pieces.map(\.text).joined()) }
        case .settles(let text, let items):
            // The rows by their words where the list knows them: "It settles 1 item" did not say which.
            let names = items.compactMap(reference)
            line("Settles", names.count == items.count && !names.isEmpty ? names.joined(separator: ", ") : text)
        case .reason(let pieces):
            line("Why", pieces.map(\.text).joined())
        case .other:
            EmptyView()
        }
    }

    private func line(_ title: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: title).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
            Text(verbatim: text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The answers the card lists: the candidates of an open row. The card does not answer, so the actions ("None of
    /// these", "Several voices", "Skip") are left out, and a decided row shows its decision instead.
    static func shownChoices(_ row: ReviewRow) -> [RowChoice] {
        guard row.isOpen else { return [] }
        return row.choices.filter { !["none", "split", "skip"].contains($0.role) }
    }

    /// The choices, highest confidence first (R49); a choice without a confidence keeps its place after them.
    private var choices: some View {
        let sorted = Self.shownChoices(row).enumerated().sorted { lhs, rhs in
            switch (lhs.element.confidence, rhs.element.confidence) {
            case let (l?, r?): return l == r ? lhs.offset < rhs.offset : l > r
            case (.some, nil): return true
            case (nil, .some): return false
            default: return lhs.offset < rhs.offset
            }
        }.map(\.element)
        return PinChoiceChips(items: sorted.map { choice in
            MeetingsWords.confidence(choice.confidence).map { "\(choice.label) \($0)" } ?? choice.label
        })
    }

    /// Only the sources a click can open: a transcript line, a document, a commit, a work item, a URL.
    private var shownSources: [RowSource] {
        row.sources.filter { if case .other = $0 { return false }; return true }
    }

    private var sources: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(shownSources.enumerated()), id: \.offset) { _, source in
                GhostButton("Show source: \(PinCard.sourceTitle(source))", symbol: PinCard.sourceSymbol(source),
                            tooltip: "Open where this item's evidence comes from",
                            identifier: "meetings.timeline.card.source") { onShowSource(source) }
            }
        }
    }

    static func sourceTitle(_ source: RowSource) -> String {
        switch source {
        case .line(let at, _, let text): return text.map { "\(at.text) “\(TimelinePin.shortText($0, limit: 40))”" } ?? "line at \(at.text)"
        case .document(let path, let line): return (path as NSString).lastPathComponent + (line.map { ":\($0)" } ?? "")
        case .commit(let sha): return "commit \(sha.prefix(10))"
        case .workItem(let id): return "work item \(id)"
        case .url(let url): return URL(string: url)?.host ?? url
        case .other(let kind): return kind
        }
    }

    static func sourceSymbol(_ source: RowSource) -> String {
        switch source {
        case .line: return "text.quote"
        case .document: return "doc.text"
        case .commit: return "arrow.triangle.branch"
        case .workItem: return "checklist"
        case .url: return "link"
        case .other: return "questionmark.circle"
        }
    }
}

/// Small chips that wrap onto more lines.
struct PinChoiceChips: View {
    let items: [String]

    var body: some View {
        WrapLayout(spacing: 6, lineSpacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Text(verbatim: item)
                    .font(.system(size: 11).monospacedDigit())
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.12)))
            }
        }
    }
}

// MARK: - When the card opens and closes

/// When the hover card shows: it opens `openDelayMs` after the pointer or the focus reaches a pin, and closes
/// `closeDelayMs` after both the pin and the card are left, so the pointer can travel from the pin into the card
/// (G-CARD-1). A pure state machine: the presenter feeds it events and sleeps for the delay it answers.
struct PinCardTiming: Equatable {
    /// `meetings.timeline.hoverDelayMs`.
    var openDelayMs: Int = 300
    var closeDelayMs: Int = 300
    /// The row the card shows; nil while closed.
    private(set) var shown: String?
    /// The row the pointer or the focus is on, and whether the pointer is inside the card.
    private(set) var pin: String?
    private(set) var inCard = false

    init(openDelayMs: Int = 300, closeDelayMs: Int = 300) {
        self.openDelayMs = openDelayMs
        self.closeDelayMs = closeDelayMs
    }

    /// The pointer or the focus reached a pin (its row id) or left every pin (nil). Answers the delay before `settle`.
    mutating func pinChanged(_ row: String?) -> Int {
        pin = row
        if let row, shown != nil, row != shown { return 0 }
        return row == nil ? closeDelayMs : (shown == nil ? openDelayMs : 0)
    }

    /// The pointer entered or left the card.
    mutating func cardHover(_ inside: Bool) -> Int {
        inCard = inside
        return inside ? 0 : closeDelayMs
    }

    /// After the delay: show the pin that is still under the pointer or focus, keep the card while the pointer is in
    /// it, else close.
    mutating func settle() {
        if let pin { shown = pin } else if !inCard { shown = nil }
    }

    /// Esc or a click elsewhere closes at once.
    mutating func close() {
        shown = nil
        pin = nil
        inCard = false
    }
}

/// Shows the pin card as a popover over the view it modifies (the timeline or the strip), driven by PinCardTiming.
/// Feed it the row id that `TimelinePinsRow.Actions.hover` reports (kept in the parent's @State) and how to draw the
/// card of a row. `anchorX` places the arrow over the pin; without it the popover points at the view's middle.
struct PinCardPresenter<Card: View>: ViewModifier {
    let hovered: String?
    /// `meetings.timeline.hoverDelayMs`.
    var openDelayMs: Int = 300
    var closeDelayMs: Int = 300
    var anchorX: (String) -> CGFloat? = { _ in nil }
    /// The anchor's edge the arrow points from: `.bottom` puts the card above a view at the window's bottom (the dock).
    var arrowEdge: Edge = .top
    let card: (String) -> Card

    @State private var timing = PinCardTiming()
    @State private var pending: Task<Void, Never>?

    // No GeometryReader around the content: it takes every point it is offered, and the dock floats over the window
    // with only the height it needs.
    func body(content: Content) -> some View {
        content
            .popover(isPresented: Binding(get: { timing.shown != nil }, set: { if !$0 { close() } }),
                     attachmentAnchor: anchor, arrowEdge: arrowEdge) {
                if let row = timing.shown {
                    card(row).onHover { inside in schedule(timing.cardHover(inside)) }
                }
            }
        .onAppear { timing = PinCardTiming(openDelayMs: openDelayMs, closeDelayMs: closeDelayMs) }
        .onChange(of: openDelayMs) { _, delay in timing.openDelayMs = delay }
        .onChange(of: hovered) { _, row in schedule(timing.pinChanged(row)) }
        .onKeyPress(.escape) {
            guard timing.shown != nil else { return .ignored }
            close()
            return .handled
        }
    }

    private var anchor: PopoverAttachmentAnchor {
        guard let row = timing.shown, let x = anchorX(row) else { return .rect(.bounds) }
        return .rect(.rect(CGRect(x: x - 1, y: 0, width: 2, height: 18)))
    }

    private func schedule(_ delayMs: Int) {
        pending?.cancel()
        guard delayMs > 0 else {
            timing.settle()
            return
        }
        pending = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(delayMs))
            guard !Task.isCancelled else { return }
            timing.settle()
        }
    }

    private func close() {
        pending?.cancel()
        timing.close()
    }
}
