import SwiftUI

/// A decision option's words, the same in the alert card, a session's inbox, the inbox of every session and the hub's
/// Inbox.
public enum WidgetOptionText {
    /// "a", "b", … for the option at `index`.
    public static func letter(_ index: Int) -> String { String(UnicodeScalar(97 + index).map(Character.init) ?? "?") }

    /// The hub names the recommended option by its letter ("b") or its whole text.
    public static func isRecommended(_ option: String, at index: Int, _ recommended: String?) -> Bool {
        guard let recommended = recommended?.trimmingCharacters(in: .whitespaces).lowercased(), !recommended.isEmpty
        else { return false }
        let lower = option.lowercased()
        return recommended == letter(index) || lower == recommended
            || lower.hasPrefix(recommended + ")") || lower.hasPrefix(recommended + ".")
    }

    /// The option text without a letter the agent already wrote ("a) Record…"); the row draws the letter itself. 176
    /// of 201 stored options began with their letter on 2026-10-27, and the hub drew "a) a) Record…" (UX audit F1).
    public static func text(_ option: String, letter: String) -> String {
        LiveWidgetView.choiceText(WidgetChoice(id: letter, title: option, recommended: false))
    }

    /// What VoiceOver reads for an option button: the verb its click does, the letter, the text, and the mark.
    public static func accessibilityLabel(letter: String, text: String, stages: Bool, recommended: Bool) -> String {
        (stages ? "Stage " : "Answer ") + letter + ": " + text + (recommended ? ", recommended" : "")
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

/// The mark of the recommended option. Green, because orange already means "waits for you" on the same card.
struct WidgetRecommendedMark: View {
    var body: some View {
        Image(systemName: "sparkle").font(.system(size: 11, weight: .semibold)).foregroundStyle(.green)
            .accessibilityHidden(true)
    }
}

/// One option row of a decision: the badge (the key that picks it, or its letter), the text, Staged, the recommended
/// mark and the keyboard's ring. The alert card, a session's inbox and the inbox of every session draw this one view.
struct WidgetOptionLabel: View {
    let badge: String
    /// The option's letter before its text, when the badge is a key ("1" stands for "a)").
    var letter: String? = nil
    let text: String
    let picked: Bool
    let recommended: Bool
    var focused = false

    static let cornerRadius: CGFloat = 8

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius)
        HStack(alignment: .top, spacing: 8) {
            Text(verbatim: badge).font(.system(size: 11, weight: .semibold, design: .rounded))
                .padding(.horizontal, 4)
                .frame(minWidth: 20, minHeight: 20)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                if let letter {
                    Text(verbatim: letter + ")").foregroundStyle(SessionPalette.secondary)
                }
                Text(text).fixedSize(horizontal: false, vertical: true)
            }
            .font(.system(size: 12))
            .padding(.top, 2)
            Spacer(minLength: 0)
            if picked {
                Text("Staged").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SessionPalette.blue).padding(.top, 2)
            }
            if recommended { WidgetRecommendedMark().padding(.top, 3) }
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
/// follow that setting.
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
        let stages = model.decisionClickStages
        Button {
            model.choose(item, option: letter)
            chosen()
        } label: {
            WidgetOptionLabel(badge: letter, text: text, picked: picked, recommended: recommended, focused: focused)
        }
        .buttonStyle(RowButtonStyle(cornerRadius: WidgetOptionLabel.cornerRadius))
        .disabled(model.sendingDecisionIDs.contains(item.sourceId))
        .instantTooltip(LiveWidgetView.choiceTooltip(WidgetChoice(id: letter, title: text, recommended: recommended),
                                                     index: 10, stages: stages, picked: picked,
                                                     swaps: model.snapshot?.state.preferences.decisionCommandSwaps ?? true))
        .accessibilityLabel(WidgetOptionText.accessibilityLabel(letter: letter, text: text, stages: stages,
                                                                recommended: recommended))
        .accessibilityValue(picked ? "Staged" : "")
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityHint(picked && stages ? "Click again to unstage" : "")
    }
}
