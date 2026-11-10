import AppKit
import SwiftUI

/// One review row (`meeting.rows`), the one row of the Items tab for questions and suggestions alike (R9, R12, R17).
/// Open, it reads as points (who, what was said, when, what it asks, what it settles, why), offers its choices with
/// the engine's confidence (R49), and opens its editor on Return or a double click (R11, R45). Decided, it folds in
/// place to one line that names who decided it and why (R16, R35), with "Revert and edit". While its Moment plays, its
/// header carries its own timeline (R25).
struct ReviewRowView: View {
    let row: ReviewRow
    let detail: MeetingDetailModel
    let player: MomentPlayer?
    var selected = false
    var editing = false
    var busy = false
    /// The entry that decided this row while its editor held a draft (G47, G48).
    var meanwhile: JournalEntry?
    var choiceKeys = true
    /// This window just decided the row and it still keeps its place (G33): it stays readable, with how it was decided
    /// where its choices were, until the reader scrolls. A folded line over the row's old height read as a blank gap.
    var held = false

    var body: some View {
        Group {
            if row.isOpen || editing || meanwhile != nil || held {
                open
            } else {
                folded
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .liveRow(selected: selected)
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
                    Label("Decided meanwhile by \(MeetingsWords.actor(meanwhile.actor)): \(MeetingsWords.entryAction(meanwhile, label: detail.rowLabel))",
                          systemImage: "person.2.badge.gearshape")
                        .font(.system(size: 12)).foregroundStyle(KitPalette.modified)
                    if let action = MeetingDetailModel.draftDecision(detail.drafts[row.id], on: row) {
                        GhostButton("Use mine instead", symbol: "arrow.uturn.forward",
                                    tooltip: "Take their decision back for this row and save what you typed") { detail.useMine(action, on: row) }
                    }
                }
            }
            if editing {
                RowEditor(row: row, detail: detail)
            } else if row.isOpen {
                choices
            } else {
                HStack(spacing: 8) {
                    decidedMark
                    decidedTail
                    Spacer(minLength: 6)
                    revertButton
                }
            }
            if !row.sources.isEmpty { sources }
        }
    }

    private var headerLine: some View {
        HStack(spacing: 6) {
            Text(verbatim: row.label).font(.system(size: 11, weight: .semibold).monospacedDigit())
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
            Text(verbatim: Self.kindWord(row.kind)).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            if let player {
                MomentButton(player: player, meeting: detail.id, target: row.target, label: row.whenText, source: .row)
            }
            if let confidence = MeetingsWords.confidence(row.confidence), row.isOpen {
                Text(verbatim: confidence).font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
            }
            if let player, let span = playingSpan(player) {
                // R25, G-ROW-1: the playing row's own timeline takes the header's free room, so the row keeps its height.
                PlayingRowBar(span: span, position: { player.position },
                              onFlag: { player.playTime($0, in: detail.id, from: .outside) },
                              onSeek: { player.playTime($0, in: detail.id, from: .outside) })
                    .frame(minWidth: 120, maxWidth: .infinity)
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
    private func playingSpan(_ player: MomentPlayer) -> ZoomSpan? {
        guard let top = player.top, top.meeting == detail.id, top.target == row.target else { return nil }
        return TimelineDock.span(of: top)
    }

    /// The row's title; a double click edits it in place (R45: "OMP" → "EMP" right there).
    @ViewBuilder
    private var title: some View {
        if !row.isQuestion {
            Text(verbatim: row.what).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                .onTapGesture(count: 2) { if row.edit != "none" { detail.edit(row) } }
                .instantTooltip(row.edit == "none" ? "" : "Double-click to edit")
        }
    }

    @ViewBuilder
    private func partLine(_ part: RowPart) -> some View {
        switch part {
        case .who(let text):
            bullet("person", Text(verbatim: text))
        case .said(let text, let speaker, let context):
            // The line above already names the speaker: the same name before the quote said it twice.
            bullet("quote.opening", saidText(text, speaker: speaker == Self.who(row) ? nil : speaker, context: context))
        case .when:
            EmptyView() // the header's MomentButton is the row's time (R13)
        case .asks(let pieces):
            pieceLine(pieces, symbol: "questionmark.bubble", size: 13, weight: row.isQuestion ? .medium : .regular)
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
                           secondary: Bool = false) -> some View {
        let font = Font.system(size: size, weight: weight)
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).font(.system(size: 10)).foregroundStyle(.tertiary).frame(width: 14).accessibilityHidden(true)
            WrapLayout(spacing: 0, lineSpacing: 2) {
                ForEach(Array(Self.units(Self.flow(pieces)).enumerated()), id: \.offset) { _, unit in
                    HStack(spacing: 0) {
                        ForEach(Array(unit.enumerated()), id: \.offset) { _, token in
                            if let target = token.piece.target, let player {
                                MomentButton(player: player, meeting: detail.id, target: target, label: token.piece.text, source: .questionTime)
                                    .padding(.horizontal, 2)
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
                ChoiceButton(choice: choice, number: choiceKeys && selected && index < 9 ? index + 1 : nil, enabled: !busy) {
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
            ForEach(Array(row.sources.enumerated()), id: \.offset) { _, source in
                switch source {
                case .line(let at, _, let text):
                    HStack(spacing: 4) {
                        if let player {
                            MomentButton(player: player, meeting: detail.id, target: .time(at.sec), label: at.text, source: .transcript)
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
        HStack(spacing: 8) {
            decidedMark
            Text(verbatim: row.label).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(.secondary)
                .lineLimit(1).fixedSize()
            // Above the spacer's priority: beside a spacer of its own priority a one-line text gets half the free
            // room and truncates with room to spare.
            Text(verbatim: Self.foldedText(row)).font(.system(size: 12.5)).lineLimit(1).truncationMode(.tail)
                .layoutPriority(0.5)
            decidedTail
            Spacer(minLength: 6)
            if busy { ProgressView().controlSize(.small) }
            revertButton
            IconButton(systemName: "clock.arrow.circlepath", tooltip: "This row's history") { detail.openHistory(item: row.id) }
                .accessibilityLabel("History of \(row.label)")
        }
    }

    private var decidedMark: some View {
        Image(systemName: row.status == "confirmed" ? "checkmark.circle.fill" : "xmark.circle")
            .foregroundStyle(row.status == "confirmed" ? KitPalette.added : KitPalette.faint)
            .accessibilityHidden(true)
    }

    /// What the row was decided as, then who decided it and why. The answer never truncates: the question before it
    /// gives way first, because a folded question that hides its answer says nothing.
    @ViewBuilder
    private var decidedTail: some View {
        if let answer = Self.foldedAnswer(row) {
            Text(verbatim: "→ \(answer)").font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                .layoutPriority(2)
        }
        Text(verbatim: Self.decidedWords(row)).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
            .layoutPriority(1)
            .instantTooltip(row.decision?.reason.map { "Why: \($0)" } ?? "")
    }

    private var revertButton: some View {
        LiveButton(tooltip: "Take this decision back for this row and edit it", enabled: !busy, pressable: true,
                   action: { detail.revertAndEdit(row) }) {
            Text("Revert and edit").font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1).fixedSize()
        }
    }

    /// The folded line's text. A question reads as its time and what it asked (its answer follows as its own text); any
    /// other row reads as `items` prints it, which already ends in what it was decided as.
    static func foldedText(_ row: ReviewRow) -> String {
        guard row.isQuestion else { return row.what }
        let asked = row.parts.compactMap { part -> String? in
            if case .asks(let pieces) = part { return pieces.map(\.text).joined() }
            return nil
        }.first
        guard let asked else { return row.what }
        return [row.whenText, asked].compactMap { $0 }.joined(separator: " ")
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
            WrapLayout(spacing: 6, lineSpacing: 2) {
                Text(verbatim: items.isEmpty ? text : "\(text):").font(.system(size: 12.5)).foregroundStyle(.secondary)
                ForEach(items, id: \.self) { id in
                    let settled = detail.rows.value?.rows.first { $0.id == id }
                    // lint-rules-ignore: short list (the one to three items a question settles; LiveButton reads the review row's liveness)
                    LiveButton(tooltip: settled.map { "\($0.what). Click to select it in the list." } ?? "Item \(id)", pressable: true,
                               action: { detail.selectedRow = id }) {
                        Text(verbatim: settled.map(Self.reference) ?? id).font(.system(size: 12)).foregroundStyle(Color.accentColor)
                    }
                    .accessibilityLabel("Select \(settled.map(Self.reference) ?? id)")
                }
            }
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
        if let player { Button("Play") { player.play(row.target, in: detail.id, from: .row) } }
        Button("History") { detail.openHistory(item: row.id) }
    }
}

/// One answer choice: its label, its number key when the row is selected (G23), and the engine's confidence as
/// secondary monospaced digits (R49, G66); none where the engine has none.
private struct ChoiceButton: View {
    let choice: RowChoice
    let number: Int?
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        // lint-rules-ignore: short list (a row's two to four answer choices; LiveButton reads the review row's liveness)
        LiveButton(tooltip: choice.hint ?? tooltip, enabled: enabled, pressable: true, action: action) {
            HStack(spacing: 5) {
                if let number {
                    Text(verbatim: "\(number)").font(.system(size: 10, weight: .semibold).monospacedDigit()).foregroundStyle(.tertiary)
                }
                Text(verbatim: choice.label).font(.system(size: 12.5, weight: choice.role == "suggested" ? .semibold : .regular))
                if let confidence = choice.confidence {
                    Text(verbatim: "\(Int((confidence * 100).rounded()))").font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Color.secondary.opacity(choice.role == "suggested" ? 0.18 : 0.08), in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityLabel(choice.confidence.map { "\(choice.label), \(Int(($0 * 100).rounded())) percent" } ?? choice.label)
    }

    private var tooltip: String {
        switch choice.role {
        case "suggested": return "The suggestion"
        case "presumed": return "The best other candidate"
        case "heard": return "The words as they were said"
        case "earlier": return "The answer of an earlier question about the same words"
        case "none": return "None of these: what it decides is rejected"
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
