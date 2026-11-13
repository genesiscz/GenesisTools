import AppKit
import SwiftUI

/// One review row (`meeting.rows`), the one row of the Items tab for questions and suggestions alike (R9, R12, R17).
/// Open, it reads as points (who, what was said, when, what it asks, what it settles, why), offers its choices with
/// the engine's confidence (R49), and opens its editor on Return or a double click (R11, R45). Decided, it folds in
/// place to one line that names who decided it and why (R16, R35), with "Revert and edit". While its Moment plays, its
/// header carries its own timeline (R25).
///
/// The row is a value (`Equatable`, `.equatable()` in the list): the list hands in what it shows (selected, editing,
/// busy, the player's state for its Moments, its draft), and a click, a hover or a play re-runs only the rows it
/// changes. `detail` and `player` are for the actions and are left out of `==`.
struct ReviewRowView: View, Equatable {
    let row: ReviewRow
    let detail: MeetingDetailModel
    // lint-rules-ignore: follows `play`, the player's state for this row's Moments, which `==` compares; the player itself only runs the actions
    let player: MomentPlayer?
    /// The player's state for this row's Moments (`MomentPlay.of`, computed by the list).
    var play: MomentPlay = .none
    var selected = false
    var editing = false
    var busy = false
    /// The entry that decided this row while its editor held a draft (G47, G48).
    var meanwhile: JournalEntry?
    var choiceKeys = true
    /// The row's draft in its editor, for "Use mine instead".
    var draft: String?
    /// The row is in `detail.changingRows`: its answer is being changed.
    var changingAnswer = false
    /// Which of `foldedShapes` a folded row draws (`foldedFit`, from the list's width).
    var foldedFit = 0
    /// How suggested, confirmed and rejected differ (`meetings.rows.stateLook`), read once here for the row's chips.
    @AppStorage(MeetingsPreferences.Rows.stateLook.key) private var stateLook = MeetingsPreferences.Rows.stateLook.defaultValue
    /// This window just decided the row and it still keeps its place (G33): its choices stay in the same slot until
    /// the reader scrolls, so another choice can change the answer without opening a separate editor.
    var held = false
    /// The list selects and focuses itself immediately, while the title still listens for a second click.
    var selectRow: (() -> Void)? = nil
    @Environment(\.kitLook) private var look
    @AppStorage(MeetingsPreferences.Playback.animateActivity.key) private var animateActivity =
        MeetingsPreferences.Playback.animateActivity.defaultValue
    @GenReduceMotion private var reduceMotion

    /// A question draws in the ask hue (not in the classic look).
    private var asks: Bool { row.isQuestion && look != .classic }

    /// An answered question whose answer is being changed: its choices show, its earlier answer confirmed among them.
    private var changing: Bool { !row.isOpen && changingAnswer }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.selected == rhs.selected && lhs.editing == rhs.editing && lhs.busy == rhs.busy
            && lhs.meanwhile == rhs.meanwhile && lhs.choiceKeys == rhs.choiceKeys && lhs.held == rhs.held
            && lhs.play == rhs.play && lhs.draft == rhs.draft && lhs.changingAnswer == rhs.changingAnswer
            && lhs.foldedFit == rhs.foldedFit && lhs.player === rhs.player
    }

    /// Every Moment the row offers to play: its own, the times in its text, and the transcript lines it comes from.
    static func targets(_ row: ReviewRow) -> [MomentTarget] {
        var targets = [row.target]
        for part in row.parts {
            switch part {
            case .asks(let pieces), .reason(let pieces): targets += pieces.compactMap(\.target)
            default: break
            }
        }
        for source in shownSources(row) {
            if case .line(let at, _, _) = source { targets.append(.time(at.sec)) }
        }
        return targets
    }

    var body: some View {
        Group {
            if row.isOpen || editing || meanwhile != nil || held || changing {
                open
            } else {
                folded
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .liveRow(selected: selected)
        .background {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.accentColor.opacity(0.07))
                .overlay(alignment: .leading) {
                    Capsule().fill(Color.accentColor.opacity(0.65)).frame(width: 2)
                }
                .opacity(play.phase == .playing ? 1 : 0)
                .animation(animateActivity && !reduceMotion ? .easeOut(duration: 0.16) : nil, value: play.phase == .playing)
                .allowsHitTesting(false)
        }
        .accessibilityElement(children: editing ? .contain : .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityActions { actions }
        .accessibilityIdentifier("meetings.row.\(row.id)")
    }

    // MARK: Open

    private var open: some View {
        VStack(alignment: .leading, spacing: 6) {
            headerLine
            Group {
                title
                ForEach(Array(row.parts.enumerated()), id: \.offset) { _, part in
                    partLine(part)
                }
            }
            .opacity(row.isOpen || editing ? 1 : 0.6)
            if let meanwhile {
                HStack(spacing: 8) {
                    Label("Decided meanwhile by \(MeetingsWords.actor(meanwhile.actor)): \(MeetingsWords.entryAction(meanwhile, label: detail.rowName))",
                          systemImage: "person.2.badge.gearshape")
                        .font(.system(size: 12)).foregroundStyle(KitPalette.modified)
                    if let action = MeetingDetailModel.draftDecision(draft, on: row) {
                        GhostButton("Use mine instead", symbol: "arrow.uturn.forward",
                                    tooltip: "Take their decision back for this row and save what you typed") { detail.useMine(action, on: row) }
                    }
                }
            }
            if editing {
                if detail.editingQuestion == row.id {
                    QuestionWordingEditor(row: row, detail: detail)
                } else {
                    RowEditor(row: row, detail: detail)
                }
            } else if row.isOpen || held {
                choices
            } else if changing {
                VStack(alignment: .leading, spacing: 6) {
                    choices
                    GhostButton("Keep \(row.answer ?? "the answer")", symbol: "arrow.uturn.backward",
                                tooltip: "Leave the answer as it is") { detail.keepAnswer(row) }
                }
            } else {
                HStack(spacing: 8) {
                    decidedMark
                    decidedTail(words: true)
                    Spacer(minLength: 6)
                    revertButton(words: true)
                }
            }
            if !Self.shownSources(row).isEmpty { sources }
        }
    }

    private var headerLine: some View {
        HStack(spacing: 6) {
            Text(verbatim: row.label).font(.system(size: 11, weight: .semibold).monospacedDigit())
                .lineLimit(1).fixedSize()
                .foregroundStyle(asks ? AnyShapeStyle(KitHue.ask.ink) : AnyShapeStyle(.primary))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(asks ? KitHue.ask.ink.opacity(0.18) : Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
            // The label, the kind and the score never break: the playing bar takes only the room they leave. Beside it at
            // 900 pt "Question" broke into "Questi" and "on", then "Q15" into "Q1" and "5", then "30 %".
            Text(verbatim: Self.kindWord(row.kind)).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(asks ? AnyShapeStyle(KitHue.ask.ink) : AnyShapeStyle(.secondary))
                .lineLimit(1).fixedSize()
            if let player {
                MomentButton(player: player, meeting: detail.id, target: row.target, label: row.whenText, source: .row,
                             shown: play.button(row.target))
            }
            if let confidence = MeetingsWords.confidence(row.confidence), row.isOpen {
                Text(verbatim: confidence).font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
                    .lineLimit(1).fixedSize()
            }
            if let player, let span = playingSpan() {
                // R25, G-ROW-1: the playing row's own timeline takes the header's free room, so the row keeps its height.
                PlayingBarSlot(span: span, player: player, meeting: detail.id)
                    .padding(.horizontal, 6)
            } else {
                Spacer(minLength: 6)
            }
            if busy { ProgressView().controlSize(.small) }
            IconButton(systemName: "clock.arrow.circlepath", tooltip: "This row's history: who decided what, and Undo") {
                detail.openHistory(item: row.id)
            }
            .accessibilityLabel("History of \(row.label)")
        }
    }


    /// The span of this row's Moment while it is the one on top of the player (R25).
    private func playingSpan() -> ZoomSpan? {
        guard let top = play.top, top.target == row.target else { return nil }
        return TimelineDock.span(of: top)
    }

    /// The row's title; a double click edits it in place (R45: "OMP" → "EMP" right there).
    @ViewBuilder
    private var title: some View {
        if !row.isQuestion {
            Text(verbatim: row.what).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                .onTapGesture(count: 2) { if row.edit != "none" { detail.edit(row) } }
                .simultaneousGesture(TapGesture().onEnded { selectTitle() })
                .instantTooltip(row.edit == "none" ? "" : "Double-click to edit")
                .frameProbe("meetings.row.\(row.id).title")
        }
    }

    private func selectTitle() {
        if let selectRow { selectRow() } else { detail.selectedRow = row.id }
    }

    @ViewBuilder
    private func partLine(_ part: RowPart) -> some View {
        switch part {
        case .who(let text):
            if row.isQuestion || !Self.whoRepeatsTitle(text, title: row.what, when: row.whenText) {
                bullet("person", Text(verbatim: text))
            }
        case .said(let text, let speaker, let context):
            // The line above already names the speaker: the same name before the quote said it twice.
            bullet("quote.opening", saidText(text, speaker: speaker == Self.who(row) ? nil : speaker, context: context))
        case .when:
            EmptyView() // the header's MomentButton is the row's time (R13)
        case .asks(let pieces):
            pieceLine(pieces, symbol: "questionmark.bubble", size: 13, weight: row.isQuestion ? .medium : .regular,
                      glyph: asks ? KitHue.ask.ink : nil)
                .onTapGesture(count: 2) { if row.isQuestion { detail.editQuestion(row) } }
                .simultaneousGesture(TapGesture().onEnded { selectTitle() })
                .instantTooltip(row.isQuestion ? "Double-click to edit the question wording" : "")
        case .settles(let text, let items):
            settlesLine(text, items: items)
        case .reason(let pieces):
            // The reason reads in full (G21): no line limit.
            pieceLine(pieces, symbol: "lightbulb", size: 11.5, secondary: true)
        case .other:
            EmptyView()
        }
    }

    private func bullet(_ symbol: String, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).font(.system(size: 10)).foregroundStyle(.tertiary).frame(width: 14).accessibilityHidden(true)
            text.font(.system(size: 12.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func saidText(_ text: String, speaker: String?, context: RowPart.Heard?) -> Text {
        let who = speaker.map { Text(verbatim: "\($0): ").fontWeight(.semibold) } ?? Text(verbatim: "")
        guard let context else { return who + Text(verbatim: "“\(text)”") }
        return who + Text(verbatim: "“\(context.lead)") + Text(verbatim: context.heard).bold().foregroundColor(.primary)
            + Text(verbatim: "\(context.rest)”")
    }

    /// Text with its times as MomentButtons (R17): a time in a question pushes on the context stack (R38). The text
    /// between two times flows word by word, so a time sits inside its sentence instead of starting a line of its own.
    private func pieceLine(_ pieces: [TextPiece], symbol: String, size: CGFloat, weight: Font.Weight = .regular,
                           secondary: Bool = false, glyph: Color? = nil) -> some View {
        let font = Font.system(size: size, weight: weight)
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).font(.system(size: glyph == nil ? 10 : 11, weight: glyph == nil ? .regular : .semibold))
                .foregroundStyle(glyph.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.tertiary)).frame(width: 14).accessibilityHidden(true)
            WrapLayout(spacing: 0, lineSpacing: 2) {
                ForEach(Array(Self.units(Self.flow(pieces)).enumerated()), id: \.offset) { _, unit in
                    HStack(spacing: 0) {
                        ForEach(Array(unit.enumerated()), id: \.offset) { index, token in
                            if let target = token.piece.target, let player {
                                // Room only toward a word. Toward "(" or ";" the pill gives up most of its own inner room:
                                // its ground is faint, so that room read as a space ("( 1:49:48 ; the answer").
                                MomentButton(player: player, meeting: detail.id, target: target, label: token.piece.text, source: .questionTime,
                                             shown: play.button(target))
                                    .padding(.leading, index == 0 ? 2 : -Self.pillGive)
                                    .padding(.trailing, index == unit.count - 1 ? 2 : -Self.pillGive)
                            } else if let url = Self.link(token.piece) {
                                Link(token.piece.text, destination: url).font(font)
                            } else {
                                Text(verbatim: token.piece.text).font(font).foregroundStyle(secondary ? .secondary : .primary)
                            }
                        }
                    }
                    .padding(.trailing, unit.last?.spaceAfter == true ? size * Self.wordSpace : 0)
                }
            }
        }
    }

    /// One layout item of a flowing sentence: a word, a time or a link, and whether a space follows it.
    struct FlowToken: Equatable {
        let piece: TextPiece
        let spaceAfter: Bool
    }

    /// A word space as a part of the font size (the system font's space is about a quarter em).
    private static let wordSpace: CGFloat = 0.25

    /// How much of a time pill's inner side room (6 pt) a mark that touches it takes.
    private static let pillGive: CGFloat = 4

    /// The items between two spaces, which stay on one line as a word does: "(" keeps the time after it, and a time
    /// keeps the ";" after it. A line breaks only where the text has a space.
    static func units(_ tokens: [FlowToken]) -> [[FlowToken]] {
        var units: [[FlowToken]] = []
        var open = false
        for token in tokens {
            if open { units[units.count - 1].append(token) } else { units.append([token]) }
            open = !token.spaceAfter
        }
        return units
    }

    /// The pieces as layout items: plain text splits into its words, a time or a link stays whole. A space in the text
    /// becomes the trailing room of the item before it, so a line never starts with one.
    static func flow(_ pieces: [TextPiece]) -> [FlowToken] {
        var tokens: [FlowToken] = []
        for piece in pieces {
            let isPlain = piece.target == nil && piece.url == nil && piece.document == nil
            guard isPlain else {
                tokens.append(FlowToken(piece: piece, spaceAfter: false))
                continue
            }
            if piece.text.first?.isWhitespace == true, let last = tokens.indices.last {
                tokens[last] = FlowToken(piece: tokens[last].piece, spaceAfter: true)
            }
            let words = piece.text.split(whereSeparator: \.isWhitespace)
            for (index, word) in words.enumerated() {
                let isLast = index == words.count - 1
                tokens.append(FlowToken(piece: TextPiece(text: String(word)),
                                        spaceAfter: !isLast || piece.text.last?.isWhitespace == true))
            }
        }
        return tokens
    }

    private static func link(_ piece: TextPiece) -> URL? {
        if let url = piece.url { return URL(string: url) }
        if let document = piece.document { return URL(fileURLWithPath: document.path) }
        return nil
    }

    /// The choices as buttons, each with its number key (G23) and the engine's confidence in secondary digits (R49).
    private var choices: some View {
        WrapLayout(spacing: 6, lineSpacing: 6) {
            ForEach(Array(row.choices.enumerated()), id: \.element.id) { index, choice in
                ChoiceButton(choice: choice, state: DecisionState.of(choice, in: row), stateLook: stateLook,
                             number: choiceKeys && selected && index < 9 ? index + 1 : nil, enabled: !busy) {
                    detail.choose(choice, on: row)
                }
            }
            if row.edit != "none" {
                GhostButton(Self.editWord(row.edit), symbol: "pencil", tooltip: "Type your own \(Self.editWord(row.edit).lowercased()) (Return)") {
                    detail.edit(row)
                }
                .disabled(busy)
            }
        }
    }

    private var sources: some View {
        HStack(spacing: 8) {
            Text("From").font(.system(size: 11)).foregroundStyle(.tertiary)
            ForEach(Array(Self.shownSources(row).enumerated()), id: \.offset) { _, source in
                switch source {
                case .line(let at, _, let text):
                    HStack(spacing: 4) {
                        if let player {
                            MomentButton(player: player, meeting: detail.id, target: .time(at.sec), label: at.text, source: .transcript,
                                         shown: play.button(.time(at.sec)))
                        }
                        if let text = Self.sourceQuote(text, in: row) {
                            Text(verbatim: "“\(text)”").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                case .document(let path, let line):
                    Button((path as NSString).lastPathComponent + (line.map { ":\($0)" } ?? "")) { PathOpener.reveal(path) }
                        .buttonStyle(.link).font(.system(size: 11))
                case .commit(let sha):
                    Text(verbatim: String(sha.prefix(10))).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                case .workItem(let id):
                    Text(verbatim: "#\(id)").font(.system(size: 11)).foregroundStyle(.secondary)
                case .url(let url):
                    if let link = URL(string: url) { Link(link.host ?? url, destination: link).font(.system(size: 11)) }
                case .other:
                    EmptyView()
                }
            }
        }
        .lineLimit(1)
    }

    // MARK: Folded

    /// A decided row, folded in place (R16): its status, who decided it and why (R35), and "Revert and edit" (G35).
    private var folded: some View {
        // A narrow column drops what the reader needs least, in this order: who decided it (the mark already says
        // that it is decided), the words of "Revert and edit" (its glyph stays), then a question's text (its answer
        // stays). Squeezed as one line, the text shrank to one character and the status to an ellipsis.
        // Each part measures as a nominal width (`FoldedShape.nominal`), so the shape follows the column's width
        // and not a row's own words: measured by its words, a row with a short answer kept its status and the row
        // under it did not.
        // The list picks the shape from its width (`foldedFit`): a `ViewThatFits` of the three built every shape
        // of every folded row on each measurement of the list (2026-11-11 lag report).
        let shapes = Self.foldedShapes(isQuestion: Self.foldedAnswer(row) != nil)
        return foldedLine(shapes[min(max(foldedFit, 0), shapes.count - 1)])
    }

    /// One shape of the folded line: the room its text needs to be worth showing (nil: no text), and whether it says
    /// who decided it and writes "Revert and edit" out.
    struct FoldedShape: Hashable {
        let textWidth: CGFloat?
        let words: Bool
        let revertWords: Bool

        /// The widths the parts measure as when the line picks its shape: a label, an answer, who decided it.
        enum Nominal {
            static let label: CGFloat = 30
            static let answer: CGFloat = 130
            static let words: CGFloat = 110
            static let gap: CGFloat = 8
        }
    }

    /// The folded line's shapes from the widest to the narrowest. A row without an answer of its own keeps its text in
    /// every shape, because the text is all it says.
    static func foldedShapes(isQuestion: Bool) -> [FoldedShape] {
        [FoldedShape(textWidth: 150, words: true, revertWords: true),
         FoldedShape(textWidth: 90, words: false, revertWords: true),
         FoldedShape(textWidth: isQuestion ? nil : 60, words: false, revertWords: false)]
    }

    /// Which of `foldedShapes` fits `room` (the row's width): the first whose parts fit at their ideal widths, in the
    /// order the `ViewThatFits` it replaces tried them, else the last. The widest before the room is known.
    static func foldedFit(_ row: ReviewRow, busy: Bool, room: CGFloat?) -> Int {
        let shapes = foldedShapes(isQuestion: foldedAnswer(row) != nil)
        guard let room else { return 0 }
        return shapes.firstIndex { foldedNeed(row, shape: $0, busy: busy) <= room } ?? shapes.count - 1
    }

    /// The width a folded line of `shape` asks for: each part at its ideal width (`foldedLine` term by term), the
    /// line's gap between them.
    @MainActor
    static func foldedNeed(_ row: ReviewRow, shape: FoldedShape, busy: Bool) -> CGFloat {
        let answer = foldedAnswer(row) != nil
        var parts: [CGFloat] = [
            KitTextWidth.symbol(row.status == "confirmed" ? "checkmark.circle.fill" : "xmark.circle", size: 13, weight: .regular),
            FoldedShape.Nominal.label,
        ]
        if !shape.words, let glyph = actorGlyph(row) { parts.append(KitTextWidth.symbol(glyph, size: 9.5, weight: .semibold) - 4) }
        if let width = shape.textWidth { parts.append(width + (answer ? 0 : FoldedShape.Nominal.answer + FoldedShape.Nominal.gap)) }
        if answer { parts.append(FoldedShape.Nominal.answer) }
        if shape.words { parts.append(FoldedShape.Nominal.words) }
        parts.append(6) // the spacer's minimum
        if busy { parts.append(16) } // a small ProgressView
        parts.append(shape.revertWords ? KitTextWidth.text("Revert and edit", size: 12, weight: .regular) : 22) // or an IconButton
        parts.append(22) // the history IconButton
        return parts.reduce(0, +) + FoldedShape.Nominal.gap * CGFloat(parts.count - 1)
    }

    private func foldedLine(_ shape: FoldedShape) -> some View {
        // A row without an answer of its own measures its text as the text and an answer, so it takes the shape the
        // questions around it take.
        let answerRoom = Self.foldedAnswer(row) == nil ? FoldedShape.Nominal.answer + FoldedShape.Nominal.gap : 0
        return HStack(spacing: FoldedShape.Nominal.gap) {
            decidedMark
            Text(verbatim: row.label).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(.secondary)
                .lineLimit(1).fixedSize()
                .frame(idealWidth: FoldedShape.Nominal.label, alignment: .leading)
                .instantTooltip(shape.textWidth == nil ? Self.foldedText(row) : "")
            if !shape.words, let glyph = Self.actorGlyph(row) {
                // The words that say who decided it are gone in this shape; a decision the reader did not make keeps a
                // mark. It stands after the label, so the labels of the rows keep one column.
                Image(systemName: glyph).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, -2)
                    .instantTooltip(Self.decidedWords(row))
                    .accessibilityLabel(Self.decidedWords(row))
            }
            if let width = shape.textWidth {
                // Above the spacer's priority: beside a spacer of its own priority a one-line text gets half the free
                // room and truncates with room to spare. The ideal width is the room this shape asks for its text.
                Text(verbatim: Self.foldedText(row)).font(.system(size: 12.5)).lineLimit(1).truncationMode(.tail)
                    .frame(idealWidth: width + answerRoom, alignment: .leading)
                    .layoutPriority(0.5)
            }
            decidedTail(words: shape.words)
            Spacer(minLength: 6)
            if busy { ProgressView().controlSize(.small) }
            revertButton(words: shape.revertWords)
            IconButton(systemName: "clock.arrow.circlepath", tooltip: "This row's history") { detail.openHistory(item: row.id) }
                .accessibilityLabel("History of \(row.label)")
        }
    }

    private var decidedMark: some View {
        let state = DecisionState.of(status: row.status)
        return Image(systemName: row.status == "confirmed" ? "checkmark.circle.fill" : "xmark.circle")
            .foregroundStyle(stateLook == .shade ? (state == .confirmed ? KitPalette.added : KitPalette.faint)
                             : (state == .rejected ? KitHue.danger.ink : KitHue.done.ink))
            .instantTooltip(Self.decidedWords(row))
            .accessibilityHidden(true)
    }

    /// The mark of a decision the reader did not make: an agent or a rule. A person's own decision has none, so a row
    /// that something else decided stands out where the line has no room for "Confirmed by an agent (…)".
    static func actorGlyph(_ row: ReviewRow) -> String? {
        switch row.decision?.actor.kind {
        case "agent": return "sparkles"
        case "rule": return "gearshape"
        default: return nil
        }
    }

    /// What the row was decided as, then who decided it and why. The answer never truncates: the question before it
    /// gives way first, because a folded question that hides its answer says nothing.
    @ViewBuilder
    private func decidedTail(words: Bool) -> some View {
        if let answer = Self.foldedAnswer(row) {
            Text(verbatim: "→ \(answer)").font(.system(size: 12.5, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(idealWidth: FoldedShape.Nominal.answer, alignment: .leading)
                .layoutPriority(2)
                .instantTooltip("\(answer)\n\(Self.decidedWords(row))")
        }
        if words {
            Text(verbatim: Self.decidedWords(row)).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
                .frame(idealWidth: FoldedShape.Nominal.words, alignment: .leading)
                .layoutPriority(1)
                .instantTooltip(row.decision?.reason.map { "Why: \($0)" } ?? "")
        }
    }

    @ViewBuilder
    private func revertButton(words: Bool) -> some View {
        let tooltip = row.isQuestion
            ? "Change the answer: it stays until you pick another, and what it carried is asked again"
            : "Take this decision back for this row and edit it"
        if words {
            LiveButton(tooltip: tooltip, enabled: !busy, pressable: true, action: { detail.revertAndEdit(row) }) {
                Text("Revert and edit").font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1).fixedSize()
            }
        } else {
            IconButton(systemName: "arrow.uturn.backward", tooltip: "Revert and edit: \(tooltip.lowercased())") { detail.revertAndEdit(row) }
                .disabled(busy)
                .accessibilityLabel("Revert and edit \(row.label)")
        }
    }

    /// The folded line's text. A question reads as its time and what it asked (its answer follows as its own text); any
    /// other row reads as `items` prints it, which already ends in what it was decided as.
    static func foldedText(_ row: ReviewRow) -> String {
        guard row.isQuestion, let asked = asked(row) else { return row.what }
        return [row.whenText, asked].compactMap { $0 }.joined(separator: " ")
    }

    /// What a question asks, as one string.
    static func asked(_ row: ReviewRow) -> String? {
        for part in row.parts { if case .asks(let pieces) = part { return pieces.map(\.text).joined() } }
        return nil
    }

    /// A row's title where its time and its answer stand beside it (the pin's card): what a question asks, else the
    /// one-line text. The one-line text of a question starts with its time and ends in its answer.
    static func title(_ row: ReviewRow) -> String {
        row.isQuestion ? asked(row) ?? row.what : row.what
    }

    /// The sources a row's "From" line shows. A transcript line at the row's own time whose words the row already
    /// quotes is left out: it was the header's time button again, on a line of its own, on most rows of a long meeting.
    static func shownSources(_ row: ReviewRow) -> [RowSource] {
        row.sources.filter { source in
            guard case .line(let at, _, let text) = source else { return true }
            return sourceQuote(text, in: row) != nil || at.sec != row.whenSec
        }
    }

    /// True when a row's who line says what its title says: a speaker range's title is "Speaker 2 01:12 → Alice" and
    /// its who line "Speaker 2 → Alice", the same two names one line apart.
    static func whoRepeatsTitle(_ who: String, title: String, when: String?) -> Bool {
        let bare = when.map { title.replacingOccurrences(of: " \($0)", with: "") } ?? title
        return bare == who
    }

    /// The answer a folded question shows after its text; nil for a row whose text already carries it.
    static func foldedAnswer(_ row: ReviewRow) -> String? {
        guard row.isQuestion, let answer = row.answer, !answer.isEmpty else { return nil }
        return answer
    }

    /// "It settles 1 item" with each item as a live reference (R17's rule for times, kept for items): the reference
    /// names the row in words, the pointer shows its text, and a click selects it in the list.
    private func settlesLine(_ text: String, items: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "checkmark.seal").font(.system(size: 10)).foregroundStyle(.tertiary).frame(width: 14).accessibilityHidden(true)
            SettlesReferences(text: text, items: items, detail: detail)
        }
    }

    /// The speaker a row names in its "who" line.
    static func who(_ row: ReviewRow) -> String? {
        for part in row.parts { if case .who(let text) = part { return text } }
        return nil
    }

    /// A source line's words, unless the row already quotes them as what was said: the same sentence twice in one row
    /// (what was said, and where it comes from) was noise. Its time stays, so the source still plays.
    static func sourceQuote(_ text: String?, in row: ReviewRow) -> String? {
        guard let text else { return nil }
        let cut = CharacterSet(charactersIn: "…").union(.whitespaces)
        let quote = text.trimmingCharacters(in: cut)
        guard !quote.isEmpty else { return nil }
        let quoted = row.parts.contains { part in
            guard case .said(let words, _, _) = part else { return false }
            let said = words.trimmingCharacters(in: cut)
            return !said.isEmpty && (said.contains(quote) || quote.contains(said))
        }
        return quoted ? nil : text
    }

    /// How a row is named where another row refers to it: "Speaker range 1:45:15–1:53:22", never a bare item id.
    static func reference(_ row: ReviewRow) -> String {
        "\(kindWord(row.kind)) \(row.whenText ?? row.label)"
    }

    /// "Confirmed by an agent (Claude Code, session 3f98b772)", "Rejected by you".
    static func decidedWords(_ row: ReviewRow) -> String {
        let status = MeetingsWords.status(row.status)
        guard let decision = row.decision else { return status }
        return "\(status) by \(decision.by)" + (decision.reason.map { ": \($0)" } ?? "")
    }

    static func kindWord(_ kind: String) -> String {
        switch kind {
        case "speaker-range": return "Speaker range"
        case "label": return "Mixed voices"
        case "join": return "Join lines"
        case "term": return "Word"
        case "question": return "Question"
        default: return kind
        }
    }

    static func editWord(_ edit: String) -> String {
        switch edit {
        case "spelling": return "Spelling"
        case "person": return "Person"
        case "answer": return "Answer"
        default: return "Edit"
        }
    }

    // MARK: Accessibility

    private var accessibilityLabel: String {
        let state = row.isOpen ? "open" : Self.decidedWords(row)
        return "\(row.label), \(Self.kindWord(row.kind)), \(row.what), \(state)"
    }

    @ViewBuilder
    private var actions: some View {
        if row.isOpen {
            ForEach(row.choices) { choice in
                Button(choice.label) { detail.choose(choice, on: row) }
            }
            if row.edit != "none" { Button("Edit") { detail.edit(row) } }
        } else {
            Button("Revert and edit") { detail.revertAndEdit(row) }
        }
        if row.isQuestion { Button("Edit question wording") { detail.editQuestion(row) } }
        if let player { Button("Play") { player.play(row.target, in: detail.id, from: .row) } }
        Button("History") { detail.openHistory(item: row.id) }
    }
}

/// One answer choice: its label, its number key when the row is selected (G23), and the engine's confidence as
/// secondary monospaced digits (R49, G66); none where the engine has none.
private struct ChoiceButton: View {
    let choice: RowChoice
    /// Suggested, confirmed (the row's answer), rejected or plain: each its own hue and glyph (genesiscz.md 12a).
    let state: DecisionState
    /// `meetings.rows.stateLook`, read once by the row.
    let stateLook: MeetingsPreferences.Rows.StateLook
    let number: Int?
    let enabled: Bool
    let action: () -> Void
    @Environment(\.kitLook) private var look

    /// The chip's ground. A suggestion is tentative: a tint of its hue with a dashed outline. A confirmed answer is a
    /// solid tint of the done hue. `shade` keeps the older look, where only the suggestion is tinted.
    @ViewBuilder
    private var ground: some View {
        let hue = state.hue(stateLook)
        let shape = RoundedRectangle(cornerRadius: look == .classic ? 6 : look.radius(.soft, height: 22, legacy: 6))
        if look == .classic {
            shape.fill(hue.map { $0.ink.opacity(0.18) } ?? Color.secondary.opacity(state == .suggested ? 0.18 : 0.08))
        } else {
            KitSurfaceBackground(look.surface(hue == nil ? .soft : .tinted, hue: hue ?? .neutral),
                                 radius: look.radius(.soft, height: 22, legacy: 6), corners: look.corners)
        }
        if stateLook == .hueAndGlyph, state.dashed, let hue {
            shape.strokeBorder(hue.ink.opacity(0.75), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        }
    }

    var body: some View {
        // lint-rules-ignore: short list (a row's two to four answer choices; LiveButton reads the review row's liveness)
        LiveButton(tooltip: choice.hint ?? tooltip, enabled: enabled, pressable: true, action: action) {
            HStack(spacing: 5) {
                if let number {
                    Text(verbatim: "\(number)").font(.system(size: 10, weight: .semibold).monospacedDigit()).foregroundStyle(.tertiary)
                }
                if let glyph = state.glyph(stateLook) {
                    Image(systemName: glyph).font(.system(size: 10, weight: .semibold))
                }
                Text(verbatim: choice.label).font(.system(size: 12.5, weight: state == .plain ? .regular : .semibold))
                    .strikethrough(state.struck)
                if let confidence = MeetingsWords.confidence(choice.confidence) {
                    // With its sign, as the row's header writes it: a bare "58" beside a name read as a count.
                    Text(verbatim: confidence).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(Self.ink(state: state, stateLook: stateLook, kitLook: look))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(ground)
        }
        .accessibilityLabel([choice.label, choice.confidence.map { "\(Int(($0 * 100).rounded())) percent" }, state.words.isEmpty ? nil : state.words]
            .compactMap { $0 }.joined(separator: ", "))
    }

    /// The label's ink: the state's hue, except the older look, which tinted only a suggestion and only in a kit look.
    static func ink(state: DecisionState, stateLook: MeetingsPreferences.Rows.StateLook, kitLook: KitLook) -> AnyShapeStyle {
        guard let hue = state.hue(stateLook), stateLook == .hueAndGlyph || kitLook != .classic else { return AnyShapeStyle(.primary) }
        return AnyShapeStyle(hue.ink)
    }

    private var tooltip: String {
        switch state {
        case .confirmed: return "The confirmed answer"
        case .rejected: return "Rejected"
        default: break
        }
        switch choice.role {
        case "suggested": return "The suggestion"
        case "presumed": return "The best other candidate"
        case "heard": return "The words as they were said"
        case "earlier": return "The answer of an earlier question about the same words"
        case "none": return "\(choice.label): what it decides is rejected"
        case "split": return "Several voices: one question per line and voice"
        case "skip": return "Leave it open for now"
        default: return "Answer “\(choice.label)”"
        }
    }
}

/// A row's inline editor (R10, R11, G4, G6, G8): the typed value, kept in the model by row id so a fold or a re-read
/// keeps it, and a reason (G5); Return saves, Esc closes and keeps the draft.
private struct RowEditor: View {
    let row: ReviewRow
    let detail: MeetingDetailModel
    @FocusState private var focused: Bool
    /// A speaker range's voice: the person picker under the field (R23), open with the editor while
    /// `meetings.rows.openPersonPicker` is on.
    @State private var picking = false
    @AppStorage(MeetingsPreferences.Rows.openPersonPicker.key) private var opensPicker =
        MeetingsPreferences.Rows.openPersonPicker.defaultValue

    /// A speaker range is confirmed as a person: the picker ranks the people in the call at its start first.
    private var picksPerson: Bool { row.kind == "speaker-range" && row.edit == "person" }

    private var draft: Binding<String> {
        Binding(get: { detail.drafts[row.id] ?? "" }, set: { detail.drafts[row.id] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField(prompt, text: draft)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                    .focused($focused)
                    .onSubmit { detail.submitDraft(on: row) }
                    .onExitCommand { detail.closeEditor() }
                    .accessibilityLabel("\(ReviewRowView.editWord(row.edit)) for \(row.label)")
                    .popover(isPresented: $picking, arrowEdge: .bottom) {
                        SpeakerNamePopover(name: draft, atSec: row.startSec) { name in
                            picking = false
                            detail.decide(row, .confirm([row.id], speaker: name))
                        }
                    }
                if picksPerson {
                    IconButton(systemName: "person.crop.circle.badge.questionmark", tooltip: "Pick the person from the people you know") {
                        picking = true
                    }
                }
                GhostButton("Save", symbol: "return", tooltip: "Save it (Return); it is confirmed so") { detail.submitDraft(on: row) }
                    .disabled(MeetingDetailModel.draftDecision(detail.drafts[row.id], on: row) == nil)
                IconButton(systemName: "xmark", tooltip: "Close the editor; what you typed stays (Esc)") { detail.closeEditor() }
            }
            TextField("Reason (optional): kept with the decision", text: Binding(get: { detail.reasons[row.id] ?? "" },
                                                                                 set: { detail.reasons[row.id] = $0 }))
                .textFieldStyle(.roundedBorder).frame(maxWidth: 420)
                .accessibilityLabel("Reason for \(row.label)")
                .accessibilityIdentifier("meetings.row.\(row.id).reason")
                .onSubmit { detail.submitDraft(on: row) }
        }
        .onAppear {
            focused = true
            if picksPerson && opensPicker { picking = true }
        }
    }

    private var prompt: String {
        switch row.edit {
        case "spelling": return "The right spelling"
        case "person": return "Who it is"
        default: return "Type what you heard"
        }
    }
}

/// A settles line's text and its items as live references. Its own view, because it reads the meeting's rows: read in
/// the row's body, every new rows list (one per decision) re-ran every row that settles something.
private struct SettlesReferences: View {
    let text: String
    let items: [String]
    let detail: MeetingDetailModel

    var body: some View {
        WrapLayout(spacing: 6, lineSpacing: 2) {
            Text(verbatim: items.isEmpty ? text : "\(text):").font(.system(size: 12.5)).foregroundStyle(.secondary)
            ForEach(items, id: \.self) { id in
                let settled = detail.rows.value?.rows.first { $0.id == id }
                // lint-rules-ignore: short list (the one to three items a question settles; LiveButton reads the review row's liveness)
                LiveButton(tooltip: settled.map { "\($0.what). Click to select it in the list." } ?? "Item \(id)", pressable: true,
                           action: { detail.reveal(row: id) }) {
                    Text(verbatim: settled.map(ReviewRowView.reference) ?? id).font(.system(size: 12)).foregroundStyle(Color.accentColor)
                }
                .accessibilityLabel("Select \(settled.map(ReviewRowView.reference) ?? id)")
            }
        }
    }
}

/// The playing row's own timeline in the header's free room (R25, G-ROW-1). In a narrow header it gives up its length
/// text first, then itself: squeezed under its smallest width, its flag drew over the text and the row's time wrapped
/// to two lines. The shape comes from the slot's width, written at whole points: a `ViewThatFits` built both bars on
/// every measurement of the row.
private struct PlayingBarSlot: View {
    let span: ZoomSpan
    let player: MomentPlayer
    let meeting: String
    /// The slot's width in whole points; nil until its first layout.
    @State private var room: CGFloat?

    var body: some View {
        let withLength = room.map { $0 >= PlayingRowBar.smallestWidth(length: true) } ?? true
        let fits = room.map { $0 >= PlayingRowBar.smallestWidth(length: false) } ?? true
        ZStack(alignment: .leading) {
            if fits {
                let smallest = PlayingRowBar.smallestWidth(length: withLength)
                PlayingRowBar(span: span, position: { player.position }, showsLength: withLength,
                              onFlag: { player.playTime($0, in: meeting, from: .outside) },
                              onSeek: { player.playTime($0, in: meeting, from: .outside) })
                    .frame(minWidth: smallest, idealWidth: smallest, maxWidth: .infinity)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width.rounded(.down) } action: { room = $0 }
    }
}
