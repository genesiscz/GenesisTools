import SwiftUI

/// A decision option's words, the same in the alert card, a session's inbox, the inbox of every session and the hub's
/// Inbox.
public enum WidgetOptionText {
    /// "a", "b", … for the option at `index`.
    public static func letter(_ index: Int) -> String { String(UnicodeScalar(97 + index).map(Character.init) ?? "?") }

    /// The index of the option `letter` names ("a" is 0) among `count` options, or nil. The reverse of `letter(_:)`;
    /// it does not lowercase, so a caller that accepts "A" lowercases first.
    public static func index(of letter: Character, count: Int) -> Int? {
        guard let scalar = letter.unicodeScalars.first?.value, scalar >= 97 else { return nil }
        let index = Int(scalar) - 97
        return index < count ? index : nil
    }

    /// The hub names the recommended option by its letter ("b"), by several letters in order when a decision takes any
    /// set of them ("abd", "a, b, d"), or by its whole text.
    public static func isRecommended(_ option: String, at index: Int, _ recommended: String?) -> Bool {
        guard let recommended = recommended?.trimmingCharacters(in: .whitespaces).lowercased(), !recommended.isEmpty
        else { return false }
        let lower = option.lowercased()
        return recommendedLetters(recommended).contains(letter(index)) || lower == recommended
            || lower.hasPrefix(recommended + ")") || lower.hasPrefix(recommended + ".")
    }

    /// The letters a recommendation names: one, or several that rise ("abd", "a + b + d"). Text names none, and a
    /// word's letters do not rise ("keep it"), so it is never read as a set. The hub's `recommendedLetters`
    /// (src/question/lib/decisions/option-labels.ts) is the same rule.
    static func recommendedLetters(_ recommended: String) -> Set<String> {
        let separators: Set<Character> = [" ", ",", "+", "&", "/"]
        var letters: [Character] = []
        for character in recommended.lowercased() where !separators.contains(character) {
            guard character >= "a", character <= "z", character.isASCII else { return [] }
            letters.append(character)
        }
        guard !letters.isEmpty, zip(letters, letters.dropFirst()).allSatisfy({ $0 < $1 }) else { return [] }
        return Set(letters.map(String.init))
    }

    /// The option text without a letter the agent already wrote ("a) Record…"); the row draws the letter itself. 176
    /// of 201 stored options began with their letter on 2026-10-27, and the hub drew "a) a) Record…" (UX audit F1).
    public static func text(_ option: String, letter: String) -> String {
        LiveWidgetView.choiceText(WidgetChoice(id: letter, title: option, recommended: false))
    }

    /// An option's text as drawn: inline markdown (code, emphasis, links), whitespace kept, as the hub's
    /// `inlineMarkdown`; the plain text when it does not parse.
    public static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }

    /// What VoiceOver reads for an option button: the verb its click does, the letter, the text, and the mark. An
    /// option of a decision that takes any set (`multiple`) is a check box: "Tick", or "Untick" while `picked`.
    public static func accessibilityLabel(letter: String, text: String, stages: Bool, recommended: Bool,
                                          multiple: Bool = false, picked: Bool = false) -> String {
        let verb = multiple ? (picked ? "Untick " : "Tick ") : (stages ? "Stage " : "Answer ")
        return verb + letter + ": " + text + (recommended ? ", recommended" : "")
    }

    /// What VoiceOver reads as an option's state: a set's check box says ticked or not, a one-letter pick where its
    /// send is (`pickedWord`: "Staged", "Sending", "Sent", "Waiting"), as its badge says.
    public static func accessibilityValue(picked: Bool, multiple: Bool, pickedWord: String = "Staged") -> String {
        multiple ? (picked ? "Ticked" : "Not ticked") : (picked ? pickedWord : "")
    }
}

/// The words every decision surface uses for the same things, in the widget and the hub (UX audit 2026-10-27: "1 need
/// you", "3 answers waiting" and "DECISION 4" beside "Decision 4" named one thing four ways).
public enum WidgetWords {
    /// "Decision 4", or "Decision" without a number. Sentence case: "DECISION 4" is how agents write it in a reply.
    public static func decision(_ number: Int?) -> String {
        number.map { "Decision \($0)" } ?? "Decision"
    }

    /// "Decision 4: Field manifest format".
    public static func numbered(_ title: String, number: Int?) -> String {
        number.map { decision($0) + ": " + title } ?? title
    }

    /// "1 waiting for your answer", "3 waiting for your answer": right for every count, unlike "1 need your answer".
    public static func waiting(_ count: Int) -> String {
        "\(count) waiting for your answer"
    }

    /// The short form beside a session's name: "1 waiting", "3 waiting".
    public static func waitingShort(_ count: Int) -> String {
        "\(count) waiting"
    }
}

/// The small rounded badge before an option's text in the widget's look: the key that picks it, or its letter.
struct WidgetOptionBadge: View {
    let text: String

    var body: some View {
        Text(verbatim: text).font(.system(size: 11, weight: .semibold, design: .rounded))
            .padding(.horizontal, 4)
            .frame(minWidth: 20, minHeight: 20)
            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
    }
}

/// The check box before an option of a decision that takes any set of its options: ticked while its letter is in the
/// staged pick. The widget's option rows and the hub's Inbox card draw this one view; it is a picture of the row's
/// state, and the row itself is the control (VoiceOver reads it from the row's label and value).
public struct WidgetOptionCheckBox: View {
    let checked: Bool
    let tint: Color

    /// The box's width; the row's text moves right by it and the row's spacing.
    public static let width: CGFloat = 18

    public init(checked: Bool, tint: Color = SessionPalette.blue) {
        self.checked = checked
        self.tint = tint
    }

    public var body: some View {
        Image(systemName: checked ? "checkmark.square.fill" : "square")
            .font(.system(size: 15))
            .foregroundStyle(checked ? tint : SessionPalette.secondary)
            .frame(width: Self.width, height: 20)
            .accessibilityHidden(true)
    }
}

/// Where an option stands: open, staged (with the word of where its send is: "Staged", "Sending", "Sent", the
/// stage phase's `word`), or the answer a closed decision took (green).
public enum DecisionOptionState: Equatable, Sendable {
    case open, staged(word: String), answered
}

/// The badge before an option's text: its letter, or the key that picks it with the letter before the text.
public enum DecisionOptionBadge: Equatable, Sendable {
    case letter(String), key(String, letter: String)
}

/// The option row's sizes: the widget's (a 20 pt rounded badge, 12 pt text, padding 8, a rest fill) or the hub Inbox
/// card's ("a)" in a 26 by 21 chip, 12.5 pt text, padding 4 by 6, no rest fill). Row sizes are a surface's own.
public enum DecisionOptionLook: Sendable {
    case widget, hub
}

public enum DecisionOptionMetrics {
    public static let cornerRadius: CGFloat = 8
    /// Where the option's text starts inside a widget row: the padding, the 20 pt badge and the gap after it. A line
    /// that belongs to the option (the agent's pick under it) starts there too.
    static let textInset: CGFloat = 8 + 20 + 8

    /// `textInset`, past the check box of a decision that takes any set of its options.
    public static func textInset(multiple: Bool) -> CGFloat {
        multiple ? textInset + WidgetOptionCheckBox.width + 8 : textInset
    }
}

/// One option row of a decision, drawn from values: the check box of a set, the badge, the text with the agent's
/// reason for it under, the staged word, the Recommended badge and the keyboard's ring. The alert card, a session's
/// inbox, the inbox of every session, the staged review list and the hub's Inbox card draw this one view; the title and
/// the reason are slots, so the hub passes its ⌘F text. The control around it is `DecisionOptionButton`.
public struct DecisionOptionRow<Title: View, Rationale: View>: View {
    let state: DecisionOptionState
    let badge: DecisionOptionBadge
    let look: DecisionOptionLook
    let recommended: Bool
    let multiple: Bool
    let focused: Bool
    /// An unpicked option of a closed decision (the hub's look): its text in grey.
    let dimmed: Bool
    let title: Title
    let rationale: Rationale

    public init(state: DecisionOptionState, badge: DecisionOptionBadge, look: DecisionOptionLook = .widget,
                recommended: Bool, multiple: Bool = false, focused: Bool = false, dimmed: Bool = false,
                @ViewBuilder title: () -> Title, @ViewBuilder rationale: () -> Rationale) {
        self.state = state
        self.badge = badge
        self.look = look
        self.recommended = recommended
        self.multiple = multiple
        self.focused = focused
        self.dimmed = dimmed
        self.title = title()
        self.rationale = rationale()
    }

    private var staged: Bool { if case .staged = state { return true } else { return false } }
    private var answered: Bool { state == .answered }
    private var stagedWord: String? { if case .staged(let word) = state { return word } else { return nil } }
    private var letter: String {
        switch badge {
        case .letter(let letter), .key(_, let letter): return letter
        }
    }

    public var body: some View {
        switch look {
        case .widget: widget
        case .hub: hub
        }
    }

    private var widget: some View {
        let shape = RoundedRectangle(cornerRadius: DecisionOptionMetrics.cornerRadius)
        return HStack(alignment: .top, spacing: 8) {
            if multiple { WidgetOptionCheckBox(checked: staged || answered, tint: answered ? .green : SessionPalette.blue) }
            switch badge {
            case .letter(let letter): WidgetOptionBadge(text: letter)
            case .key(let key, _): WidgetOptionBadge(text: key)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if case .key(_, let letter) = badge {
                        Text(verbatim: letter + ")").foregroundStyle(SessionPalette.secondary)
                    }
                    title.fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(size: 12))
                rationale.font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 2)
            Spacer(minLength: 0)
            // A set's ticked box already says it; the word stays for a one-letter pick.
            if let stagedWord, !multiple {
                Text(stagedWord).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SessionPalette.blue).padding(.top, 2)
            }
            if answered {
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.green)
                    .padding(.top, 3).accessibilityHidden(true)
            } else if recommended {
                // Green, because orange already means "waits for you" on the same card.
                DecisionRecommendedBadge().padding(.top, 1)
            }
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(answered ? Color.green.opacity(0.12) : staged ? SessionPalette.blue.opacity(0.16) : .white.opacity(0.06),
                    in: shape)
        .overlay(shape.strokeBorder(answered ? Color.green.opacity(0.45) : staged ? SessionPalette.blue.opacity(0.7) : .clear,
                                    lineWidth: 1))
        // The keyboard's option: the focus ring of the system's own controls.
        .overlay(shape.strokeBorder(focused ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear, lineWidth: 2))
        .contentShape(shape)
    }

    private var hub: some View {
        let shape = RoundedRectangle(cornerRadius: DecisionOptionMetrics.cornerRadius)
        return HStack(alignment: .top, spacing: 9) {
            if multiple {
                // Ticked in the staged blue while open, in the answered green once closed.
                WidgetOptionCheckBox(checked: staged || answered, tint: answered ? KitPalette.added : SessionPalette.blue)
                    .padding(.top, 0.5)
            }
            // A staged letter is the widget's blue, never the green of "answered" (F2); the deep send blue keeps the
            // white letter at 4.5:1.
            Text(verbatim: letter + ")")
                .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                .foregroundColor(staged ? .white : answered ? .black : Color.white.opacity(0.85))
                .frame(width: 26, height: 21)
                .background(RoundedRectangle(cornerRadius: 5).fill(
                    staged ? GenPrimaryButtonStyle.blue : answered ? KitPalette.added : Color.white.opacity(0.08)))
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    title
                        .font(.system(size: 12.5))
                        .foregroundColor(Color.white.opacity(dimmed ? 0.55 : 0.92))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if recommended {
                        DecisionRecommendedBadge()
                    }
                    if let stagedWord, !multiple {
                        Text(stagedWord)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(SessionPalette.blue)
                    }
                }
                rationale
                    .font(.system(size: 11))
                    .foregroundColor(KitPalette.dim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(staged ? SessionPalette.blue.opacity(0.16) : Color.clear, in: shape)
        .overlay(shape.strokeBorder(staged ? SessionPalette.blue.opacity(0.7) : .clear, lineWidth: 1))
        .contentShape(shape)
    }
}

/// The agent's reason for an option, under its text; nothing when it gave none.
public struct DecisionOptionRationale: View {
    let text: String?

    public init(_ text: String?) { self.text = text }

    public var body: some View {
        if let text, !text.isEmpty { Text(.init(text)) }
    }
}

public extension DecisionOptionRow where Title == Text, Rationale == DecisionOptionRationale {
    /// The text as inline markdown (`WidgetOptionText.markdown`) and the agent's reason under it.
    init(state: DecisionOptionState, badge: DecisionOptionBadge, look: DecisionOptionLook = .widget,
         recommended: Bool, multiple: Bool = false, focused: Bool = false, dimmed: Bool = false,
         text: String, rationale: String?) {
        self.init(state: state, badge: badge, look: look, recommended: recommended, multiple: multiple,
                  focused: focused, dimmed: dimmed) {
            Text(WidgetOptionText.markdown(text))
        } rationale: {
            DecisionOptionRationale(rationale)
        }
    }
}

/// An option row as its control: a `Button` with the kit's row style while live, the same label as a resting control
/// at rest (`restingButton`, which VoiceOver and `tools control` still press), so a dense list's resting rows carry
/// no responder. `live` nil reads the row's `rowLive`.
public struct DecisionOptionButton<Label: View>: View {
    @Environment(\.rowLive) private var rowLive
    let live: Bool?
    let enabled: Bool
    let tooltip: String
    let action: () -> Void
    let label: Label

    public init(live: Bool? = nil, enabled: Bool = true, tooltip: String, action: @escaping () -> Void,
                @ViewBuilder label: () -> Label) {
        self.live = live
        self.enabled = enabled
        self.tooltip = tooltip
        self.action = action
        self.label = label()
    }

    public var body: some View {
        if live ?? rowLive {
            Button(action: action) { label }
                // The kit's row button: a soft fill in the row's own frame, not the white outline (P1).
                .buttonStyle(RowButtonStyle(cornerRadius: DecisionOptionMetrics.cornerRadius))
                .disabled(!enabled)
                .instantTooltip(tooltip)
        } else {
            label.restingButton(enabled: enabled, action: action)
        }
    }
}

/// An option of a decision as the widget's button: from an inbox item (the alert card, the inbox of every session,
/// the staged review list) or from a session's card (its key badge, the agent's reason and the card's own disabled
/// rule). It stages, or with "Send at once" sends, as the Decision click setting says (`WidgetModel.choose`), and its
/// words follow that setting. An option of a decision that takes any set of its options is a check box: a click ticks
/// or unticks it in every click mode, and the decision's Send sends the set.
struct WidgetOptionButton: View {
    // lint-rules-ignore: the options of one open decision, observes on purpose
    @ObservedObject var model: WidgetModel
    private enum Source {
        case item(WidgetInboxItem, index: Int, option: String)
        case card(WidgetCard, choice: WidgetChoice, index: Int, key: String?, picked: Bool)
    }
    private let source: Source
    private let focused: Bool
    /// Runs after the click has staged or sent the pick.
    private let chosen: () -> Void

    init(model: WidgetModel, item: WidgetInboxItem, index: Int, option: String, focused: Bool = false,
         chosen: @escaping () -> Void = {}) {
        self.model = model
        source = .item(item, index: index, option: option)
        self.focused = focused
        self.chosen = chosen
    }

    init(model: WidgetModel, card: WidgetCard, choice: WidgetChoice, index: Int, key: String?, picked: Bool,
         focused: Bool) {
        self.model = model
        source = .card(card, choice: choice, index: index, key: key, picked: picked)
        self.focused = focused
        chosen = {}
    }

    var body: some View {
        switch source {
        case let .item(item, index, option): itemButton(item, index: index, option: option)
        case let .card(card, choice, index, key, picked): cardButton(card, choice: choice, index: index, key: key, picked: picked)
        }
    }

    private func itemButton(_ item: WidgetInboxItem, index: Int, option: String) -> some View {
        let letter = WidgetOptionText.letter(index)
        let text = WidgetOptionText.text(option, letter: letter)
        // A ⇧-pick in the hub stages several letters ("ac"): each of them reads Staged (F14).
        let picked = model.shownStagedOption(item.sourceId, stored: item.draftOption)?.contains(letter) ?? false
        let recommended = WidgetOptionText.isRecommended(option, at: index, item.recommended)
        let stages = item.kind == "decision" && model.decisionClickStages
        let multiple = item.takesSeveral
        let pickedWord = model.stagePhase(item.sourceId, draftedAt: item.draftedAt).word
        return DecisionOptionButton(
            live: true,
            enabled: !(model.sendingDecisionIDs.contains(item.sourceId) || model.dialogSendingIDs.contains(item.sourceId)),
            tooltip: item.kind == "dialog" ? "Send this option to the open dialog." : DecisionAnswering.optionTooltip(
                letter, recommended: recommended, stages: stages, picked: picked,
                swaps: model.preferences.decisionCommandSwaps, multiple: multiple),
            action: {
                model.choose(item, option: letter)
                chosen()
            }) {
            DecisionOptionRow(state: picked ? .staged(word: pickedWord) : .open, badge: .letter(letter),
                              recommended: recommended, multiple: multiple, focused: focused, text: text, rationale: nil)
        }
        .accessibilityLabel(WidgetOptionText.accessibilityLabel(letter: letter, text: text, stages: stages,
                                                                recommended: recommended, multiple: multiple,
                                                                picked: picked))
        .accessibilityValue(WidgetOptionText.accessibilityValue(picked: picked, multiple: multiple,
                                                                pickedWord: pickedWord))
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityHint(picked && stages && !multiple ? "Click again to unstage" : "")
    }

    private func cardButton(_ card: WidgetCard, choice: WidgetChoice, index: Int, key: String?, picked: Bool) -> some View {
        let stages = card.kind == "decision" && model.decisionClickStages
        // A decision that takes any set of its options: a check box per option, and a click only ticks it.
        let multiple = card.takesSeveral
        let text = LiveWidgetView.choiceText(choice)
        let pickedWord = model.stagePhase(card.sourceId, draftedAt: card.draftedAt).word
        return DecisionOptionButton(
            live: true,
            // An answer on its way takes no second, conflicting pick (forms say "Answer queued" the same way).
            enabled: !(model.importing > 0 || model.cardPending || model.sendingDecisionIDs.contains(card.sourceId)
                       || model.dialogSendingIDs.contains(card.sourceId)),
            tooltip: card.kind == "dialog" ? "Send this option to the open dialog." : DecisionAnswering.optionTooltip(
                choice.id, recommended: choice.recommended, stages: stages, picked: picked,
                swaps: model.preferences.decisionCommandSwaps, key: index < 9 ? index + 1 : nil, multiple: multiple),
            action: { model.choose(card, option: choice.id) }) {
            // The badge is the key that picks the option; the letter, which the agent and the hub name it by, leads
            // its text. Up and Down move through the options; the chosen one wears the focus ring.
            DecisionOptionRow(state: picked ? .staged(word: pickedWord) : .open,
                              badge: key.map { .key($0, letter: choice.id) } ?? .letter(choice.id),
                              recommended: choice.recommended, multiple: multiple, focused: focused, text: text,
                              rationale: choice.rationale)
        }
        .accessibilityLabel(WidgetOptionText.accessibilityLabel(letter: choice.id, text: text, stages: stages,
                                                                recommended: choice.recommended, multiple: multiple,
                                                                picked: picked)
            + (choice.rationale.map { ". " + $0 } ?? ""))
        .accessibilityValue(WidgetOptionText.accessibilityValue(picked: picked, multiple: multiple,
                                                                pickedWord: pickedWord))
        // Selected is the staged pick; the keyboard's option shows by its focus ring and VoiceOver's own cursor.
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityHint(picked && stages && !multiple ? "Click again to unstage" : "")
    }
}

/// "Pick the recommended a + b + c": one click ticks exactly the set the agent recommends, for a decision that takes
/// any set of its options. Nothing is sent; the decision's Send does that. A quiet link-like button under the options.
public struct WidgetRecommendedPickButton: View {
    let letters: String
    let action: () -> Void

    public init(letters: String, action: @escaping () -> Void) {
        self.letters = letters
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            // The line is 14 pt of text: the 22 pt row is the hit area.
            Label(DecisionAnswering.recommendedPickTitle(letters), systemImage: "checkmark.square")
                .font(.system(size: 11))
                .frame(minHeight: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .foregroundStyle(SessionPalette.secondary)
        .instantTooltip("Ticks exactly the options the agent recommends. Nothing is sent until you press Send.")
    }
}

/// The staged state's own actions of one decision, on every surface that draws one: Send (its title says where the send
/// is), Unstage, "Send now (all N)" while another decision is staged too, and for a decision that takes any set of its
/// options the recommended set in one click. Send and Unstage show while a pick or a note is staged, for a set and for
/// one letter. Values in, actions out, so a row that draws them observes no model for them; a nil closure hides its
/// button.
public struct WidgetStagedActions: View {
    /// `row`: its own line under the options, which wraps at a narrow width, the recommended pick first and Send last.
    /// `footer`: Send, Unstage and Send now (all N) for a footer's row, which gives them its own style and font.
    public enum Placement: Sendable { case row, footer }

    let letters: String?
    let takesSeveral: Bool
    let recommendedSet: String?
    let phase: WidgetStagePhase
    let staged: Bool
    let busy: Bool
    let othersStaged: Int
    let placement: Placement
    let sendSymbol: String?
    let identifier: String
    let sendAllIdentifier: String?
    let unstageIdentifier: String?
    let unstageTooltip: String
    let send: () -> Void
    let unstage: (() -> Void)?
    let sendAll: (() -> Void)?
    let pickRecommended: ((String) -> Void)?

    /// `letters`: the staged pick ("ac"), nil while none is. `staged`: a pick or a note waits. `busy`: this decision's
    /// send runs. `othersStaged`: the other decisions staged now, for Send now (all N).
    public init(letters: String?, takesSeveral: Bool, recommendedSet: String?, phase: WidgetStagePhase,
                staged: Bool, busy: Bool, othersStaged: Int = 0, placement: Placement,
                sendSymbol: String? = nil, identifier: String, sendAllIdentifier: String? = nil,
                unstageIdentifier: String? = nil, unstageTooltip: String = "Clears the staged pick.",
                send: @escaping () -> Void, unstage: (() -> Void)? = nil, sendAll: (() -> Void)? = nil,
                pickRecommended: ((String) -> Void)? = nil) {
        self.letters = letters
        self.takesSeveral = takesSeveral
        self.recommendedSet = recommendedSet
        self.phase = phase
        self.staged = staged
        self.busy = busy
        self.othersStaged = othersStaged
        self.placement = placement
        self.sendSymbol = sendSymbol
        self.identifier = identifier
        self.sendAllIdentifier = sendAllIdentifier
        self.unstageIdentifier = unstageIdentifier
        self.unstageTooltip = unstageTooltip
        self.send = send
        self.unstage = unstage
        self.sendAll = sendAll
        self.pickRecommended = pickRecommended
    }

    /// The stage and the actions of one decision from its surface's host. `unstages` false hides Unstage (the alert,
    /// where a second click on the option unstages).
    public init(host: any DecisionStagingHost, placement: Placement, sendSymbol: String? = nil, identifier: String,
                sendAllIdentifier: String? = nil, unstageIdentifier: String? = nil,
                unstageTooltip: String = "Clears the staged pick.", unstages: Bool = true) {
        let stage = host.stage
        self.init(letters: stage.letters, takesSeveral: stage.takesSeveral, recommendedSet: stage.recommendedSet,
                  phase: stage.phase, staged: stage.staged, busy: stage.busy, othersStaged: stage.othersStaged,
                  placement: placement, sendSymbol: sendSymbol, identifier: identifier,
                  sendAllIdentifier: sendAllIdentifier, unstageIdentifier: unstageIdentifier,
                  unstageTooltip: unstageTooltip, send: { host.send() }, unstage: unstages ? { host.unstage() } : nil,
                  sendAll: { host.sendAll() }, pickRecommended: { host.pickSet($0) })
    }

    public var body: some View {
        switch placement {
        case .row:
            if staged || offersRecommended {
                WrapLayout(spacing: 8, lineSpacing: 6) {
                    if offersRecommended, let recommendedSet, let pickRecommended {
                        WidgetRecommendedPickButton(letters: recommendedSet) { pickRecommended(recommendedSet) }
                    }
                    if staged {
                        unstageButton
                        sendAllButton
                        sendButton
                    }
                }
                .buttonStyle(.genHover()).font(.system(size: 11.5))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .footer:
            if staged {
                sendButton
                unstageButton
                sendAllButton
            }
        }
    }

    private var offersRecommended: Bool {
        pickRecommended != nil && (recommendedSet.map { $0 != letters } ?? false)
    }

    @Environment(\.rowLive) private var rowLive

    @ViewBuilder private var sendButton: some View {
        let title = phase.sendTitle(letters, multiple: takesSeveral)
        Group {
            if rowLive {
                Button(action: send) {
                    if let sendSymbol { Label(title, systemImage: sendSymbol) } else { Text(title) }
                }
            } else {
                Text(title).restingButton(enabled: !busy && !phase.onItsWay, action: send)
            }
        }
        .buttonStyle(.genPrimary())
        .fixedSize()
        .disabled(busy || phase.onItsWay)
        .instantTooltip(takesSeveral && letters != nil ? DecisionAnswering.setSendTooltip(letters)
                                                       : "Sends this staged decision alone, without the others.")
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder private var unstageButton: some View {
        if let unstage {
            StagedActionButton(title: "Unstage", enabled: !busy, tooltip: unstageTooltip, identifier: unstageIdentifier,
                               action: unstage)
        }
    }

    @ViewBuilder private var sendAllButton: some View {
        // Only while another decision is staged too: alone it is the same as Send.
        if othersStaged > 0, let sendAll {
            StagedActionButton(title: "Send now (all \(othersStaged + 1))", enabled: !busy,
                               tooltip: "Sends this decision and the \(Plural.count(othersStaged, "other staged decision")) now, one message per session.",
                               identifier: sendAllIdentifier, action: sendAll)
        }
    }
}

/// A quiet action of the staged block: a `Button` in the caller's style while the row is live, the same words as a
/// resting control at rest, which VoiceOver still presses (a raw `Button` in a hub row is the defect).
private struct StagedActionButton: View {
    @Environment(\.rowLive) private var rowLive
    let title: String
    let enabled: Bool
    let tooltip: String
    let identifier: String?
    let action: () -> Void

    var body: some View {
        if rowLive {
            Button(title, action: action).disabled(!enabled).instantTooltip(tooltip).identifier(identifier)
        } else {
            Text(title).opacity(enabled ? 1 : 0.4).restingButton(enabled: enabled, action: action).identifier(identifier)
        }
    }
}

private extension View {
    @ViewBuilder func identifier(_ identifier: String?) -> some View {
        if let identifier { accessibilityIdentifier(identifier) } else { self }
    }
}

/// "Asked in Review of the cache PR, a sub-agent of Overnight lead": the asking session of a decision another agent's
/// thread started. Each session numbers its own decisions, so a lead and its sub-agents can each show a DECISION 1, and
/// this line tells them apart in the widget and the hub (DECISION 46 b, 2026-11-07).
public struct WidgetAskedInLine: View {
    let askedIn: String

    public init(_ askedIn: String) { self.askedIn = askedIn }

    public var body: some View {
        Label("Asked in " + askedIn, systemImage: "arrow.turn.down.right")
            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            .labelStyle(.titleAndIcon)
            .accessibilityLabel("Asked in " + askedIn)
    }
}
