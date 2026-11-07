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

    /// What VoiceOver reads as an option's state: a set's check box says ticked or not, a one-letter pick "Staged".
    public static func accessibilityValue(picked: Bool, multiple: Bool) -> String {
        multiple ? (picked ? "Ticked" : "Not ticked") : (picked ? "Staged" : "")
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

/// The small rounded badge before an option's text: the key that picks it, or its letter. The option row and the
/// answered option row draw this one view.
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

/// One option row of a decision: the badge (the key that picks it, or its letter), the text with the agent's reason
/// for it under, Staged, the Recommended badge (the hub Inbox's, `DecisionRecommendedBadge`) and the keyboard's ring.
/// The alert card, a session's inbox and the inbox of every session draw this one view. An option of a decision that
/// takes any set (`multiple`) leads with its check box instead of saying Staged.
struct WidgetOptionLabel: View {
    let badge: String
    /// The option's letter before its text, when the badge is a key ("1" stands for "a)").
    var letter: String? = nil
    let text: String
    let picked: Bool
    let recommended: Bool
    var focused = false
    /// Why this option, when the agent said (`WidgetChoice.rationale`): dim, under the text, as in the hub.
    var rationale: String? = nil
    /// The decision takes any set of its options: a check box that is ticked while `picked`.
    var multiple = false

    static let cornerRadius: CGFloat = 8
    /// Where the option's text starts inside the row: the padding, the 20 pt badge and the gap after it. A line that
    /// belongs to the option (the agent's pick under it) starts there too.
    static let textInset: CGFloat = 8 + 20 + 8

    /// `textInset`, past the check box of a decision that takes any set of its options.
    static func textInset(multiple: Bool) -> CGFloat {
        multiple ? textInset + WidgetOptionCheckBox.width + 8 : textInset
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius)
        HStack(alignment: .top, spacing: 8) {
            if multiple { WidgetOptionCheckBox(checked: picked) }
            WidgetOptionBadge(text: badge)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if let letter {
                        Text(verbatim: letter + ")").foregroundStyle(SessionPalette.secondary)
                    }
                    // Inline markdown, as the hub's option rows draw it: an option's words often come from the
                    // prompt's "a) …" line, where `tools rm ask` is code, not text with backticks.
                    Text(WidgetOptionText.markdown(text)).fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(size: 12))
                if let rationale, !rationale.isEmpty {
                    Text(.init(rationale)).font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 2)
            Spacer(minLength: 0)
            // A set's ticked box already says it; the word stays for a one-letter pick.
            if picked && !multiple {
                Text("Staged").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SessionPalette.blue).padding(.top, 2)
            }
            // Green, because orange already means "waits for you" on the same card.
            if recommended { DecisionRecommendedBadge().padding(.top, 1) }
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(picked ? SessionPalette.blue.opacity(0.16) : .white.opacity(0.06), in: shape)
        .overlay(shape.strokeBorder(picked ? SessionPalette.blue.opacity(0.7) : .clear, lineWidth: 1))
        // The keyboard's option: the focus ring of the system's own controls.
        .overlay(shape.strokeBorder(focused ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear, lineWidth: 2))
        .contentShape(shape)
    }
}

/// An option of a decision from the inbox list (the alert card, the inbox of every session) as a button. It stages,
/// or with "Send at once" sends, as the Decision click setting says (`WidgetModel.choose(_:option:)`), and its words
/// follow that setting. An option of a decision that takes any set of its options is a check box: a click ticks or
/// unticks it in every click mode, and the decision's Send sends the set.
struct WidgetItemOptionButton: View {
    @ObservedObject var model: WidgetModel
    let item: WidgetInboxItem
    let index: Int
    let option: String
    var focused = false
    /// Runs after the click has staged or sent the pick.
    var chosen: () -> Void = {}

    var body: some View {
        let letter = WidgetOptionText.letter(index)
        let text = WidgetOptionText.text(option, letter: letter)
        // A ⇧-pick in the hub stages several letters ("ac"): each of them reads Staged (F14).
        let picked = model.shownStagedOption(item.sourceId, stored: item.draftOption)?.contains(letter) ?? false
        let recommended = WidgetOptionText.isRecommended(option, at: index, item.recommended)
        let stages = item.kind == "decision" && model.decisionClickStages
        let multiple = item.takesSeveral
        Button {
            model.choose(item, option: letter)
            chosen()
        } label: {
            WidgetOptionLabel(badge: letter, text: text, picked: picked, recommended: recommended, focused: focused,
                              multiple: multiple)
        }
        .buttonStyle(RowButtonStyle(cornerRadius: WidgetOptionLabel.cornerRadius))
        .disabled(model.sendingDecisionIDs.contains(item.sourceId) || model.dialogSendingIDs.contains(item.sourceId))
        .instantTooltip(item.kind == "dialog" ? "Send this option to the open dialog." : DecisionAnswering.optionTooltip(
            letter, recommended: recommended, stages: stages, picked: picked,
            swaps: model.snapshot?.state.preferences.decisionCommandSwaps ?? true, multiple: multiple))
        .accessibilityLabel(WidgetOptionText.accessibilityLabel(letter: letter, text: text, stages: stages,
                                                                recommended: recommended, multiple: multiple,
                                                                picked: picked))
        .accessibilityValue(WidgetOptionText.accessibilityValue(picked: picked, multiple: multiple))
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

/// The Send of a decision that takes any set of its options, where its options are listed with no Send of their own
/// (the inbox of every session, a staged decision opened in the review list): "Send a + c" once a letter is ticked,
/// and the recommended set in one click while it is not the ticked one. Values in, actions out, so the row that draws
/// it does not observe the model for it.
struct WidgetSetSendBar: View {
    /// The ticked letters ("ac"), nil while none is.
    let letters: String?
    /// The set the agent recommends (`DecisionAnswering.recommendedSet`), nil when it names one option or none.
    let recommended: String?
    let sending: Bool
    let identifier: String
    let pick: (String) -> Void
    let send: () -> Void

    var body: some View {
        let offersRecommended = recommended.map { $0 != letters } ?? false
        if letters != nil || offersRecommended {
            HStack(spacing: 8) {
                if offersRecommended, let recommended {
                    WidgetRecommendedPickButton(letters: recommended) { pick(recommended) }
                }
                Spacer(minLength: 0)
                if let letters {
                    Button(sending ? "Sending…" : DecisionAnswering.sendTitle(letters, multiple: true), action: send)
                        .buttonStyle(.genPrimary())
                        .font(.system(size: 11.5))
                        .disabled(sending)
                        .instantTooltip(DecisionAnswering.setSendTooltip(letters))
                        .accessibilityIdentifier(identifier)
                }
            }
        }
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
