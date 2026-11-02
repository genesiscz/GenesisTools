import SwiftUI

/// What an open decision card shows besides its question and options, as the hub's Inbox card does (Martin,
/// 2026-11-01: "the widget doesnt show all the context of the decisions? ... i want this too in the widget"): the
/// Context and Code sections the hub draws with the same views (DecisionDetailViews.swift), the notes, and the agent's
/// pick with its reason when it does not sit under its option. Decision cards (Widgets → General) set the fold, the
/// code and where the pick goes.
struct WidgetDecisionDetailsView: View {
    let card: WidgetCard
    let details: WidgetDecisionDetails
    let preferences: WidgetPreferences?
    /// The agent's pick goes here, above the options; nil when it sits under its option (`WidgetProposal.underOption`).
    let proposal: String?

    /// The cited files with lines to show or a file that is gone, unless Code is set to Hide.
    private var codeRefs: [DecisionRef] {
        preferences?.decisionCode == "hide" ? [] : (details.refs ?? []).filter(\.hasContent)
    }

    var body: some View {
        let _ = RenderProbe.hit("widget.decision.details.body")
        VStack(alignment: .leading, spacing: 10) {
            if let context = details.context, !context.isEmpty {
                DecisionContextSection(markdown: context, startsOpen: preferences?.decisionContext == "open")
            }
            if !codeRefs.isEmpty {
                DecisionCodeSection(refs: codeRefs, root: card.sourceContext?.repoRoot ?? card.sourceContext?.cwd)
            }
            if let notes = details.notes, !notes.isEmpty {
                Text(.init(notes))
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .pathLinkMenu(markdown: notes)
            }
            if let proposal {
                WidgetProposalLine(text: proposal)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The agent's pick with its reason, behind a lightbulb, as the hub's Inbox card draws it. A file link in it opens by
/// the widget's setting on a click and lists its ways to open on a right-click, as a card's body does.
struct WidgetProposalLine: View {
    let text: String

    /// The hub Inbox's accent (`InboxStyle.accent`), a little dimmer.
    static let bulb = Color(red: 1, green: 0.63, blue: 0.12).opacity(0.9)

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "lightbulb").foregroundStyle(Self.bulb).accessibilityHidden(true)
            Text(.init(text)).italic().fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 12))
        .foregroundStyle(Color.white.opacity(0.8))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("The agent's pick: ") + Text(.init(text)))
        .pathLinkMenu(markdown: text)
    }
}

/// Where a decision card puts the agent's pick (the proposal): under the recommended option, without the letter it
/// starts with, or above the options.
enum WidgetProposal {
    /// "a): ", "(a) ", "a. ", "a: ": a proposal that starts by naming its option.
    private static let leadingLetter = try? NSRegularExpression(pattern: #"^\(?([A-Za-z])(?:\)|\.|:):?\s+"#)

    /// The proposal as it reads under the recommended option `letter`: without a leading "a): " that names it. Nil
    /// when it names another option (it then stays above the options) or when nothing is left.
    static func underOption(_ proposal: String, letter: String) -> String? {
        let text = proposal.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(text.startIndex..., in: text)
        guard let match = leadingLetter?.firstMatch(in: text, range: range),
              let named = Range(match.range(at: 1), in: text), let whole = Range(match.range, in: text)
        else {
            return text.isEmpty ? nil : text
        }
        guard text[named].lowercased() == letter.lowercased() else { return nil }
        let rest = String(text[whole.upperBound...])
        return rest.isEmpty ? nil : rest
    }

    /// The option the pick sits under and its text there, when the card shows its options, recommends one and is set
    /// to put the pick under it (`decisionProposal`, default "option").
    static func placement(_ card: WidgetCard, preferences: WidgetPreferences?) -> (letter: String, text: String)? {
        guard card.kind == "decision", card.needsAnswer, preferences?.decisionProposal != "above",
              let proposal = card.decision?.proposal,
              let letter = card.decision?.recommended ?? card.choices.first(where: \.recommended)?.id,
              card.choices.contains(where: { $0.id == letter }),
              let text = underOption(proposal, letter: letter)
        else { return nil }
        return (letter, text)
    }
}
