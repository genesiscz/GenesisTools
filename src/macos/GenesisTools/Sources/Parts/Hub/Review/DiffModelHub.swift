import Foundation
import GenesisKit

extension DiffViewOptions {
    /// The style a new review opens with: the Diff layout setting (Settings, Hub, Panes; `HubDiffLayout`). Auto opens
    /// side by side, and the pane's width then decides (`ReviewModel.fitStyle`). The header's Split / Unified button
    /// picks for one review and is not stored: before 2026-11-09 it was (`review.diffStyle`), and one click made every
    /// later review keep that style, also in a pane too narrow for two sides.
    static func remembered(in store: UserDefaults = HubDefaults.store) -> DiffViewOptions {
        var options = DiffViewOptions()
        options.diffStyle = HubDiffLayout.stored(in: store) == .unified ? .unified : .split
        return options
    }
}

/// Whether one card's send (For agent, Draft on PR, Post on PR, Promote) may start. The page drops a
/// card's send buttons once it went out, but a double click posts twice before the page redraws, and
/// Swift ran both: two drafts on the PR, or two agent comments. Swift checks the states the page
/// checks (main.ts `renderDraft`, `renderReply`, `renderComment`), plus a send still on its way.
enum SuggestionSendGate {
    /// `kind` is the card's kind ("draft", "thread", "local"); `state` is what the page reads: a
    /// draft's status, a thread reply's `replyStatus` (nil until sent), a local comment's state.
    static func refusal(kind: String, state: String?, toPR: Bool, inFlight: Bool, busy: String?) -> String? {
        if inFlight {
            return "This suggestion is already on its way."
        }
        if toPR, let busy {
            return "\(busy) Wait until it finishes, then send again."
        }
        switch kind {
        case "draft" where ["sent", "drafted", "posted"].contains(state ?? ""):
            return "This suggestion was already sent (\(state ?? ""))."
        case "thread" where state != nil:
            return "This reply was already sent (\(state ?? ""))."
        case "local" where state == "posted":
            return "This comment is already posted on the PR."
        default:
            return nil
        }
    }
}
