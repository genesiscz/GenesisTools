import Foundation
import GenesisKit

extension DiffViewOptions {
    /// The layout picked last in any review (its header button, the View menu): every new review window
    /// and hub review opens with it, after a relaunch too.
    static let styleKey = "review.diffStyle"

    static func remembered(in store: UserDefaults = HubDefaults.store) -> DiffViewOptions {
        var options = DiffViewOptions()
        if let saved = store.string(forKey: styleKey).flatMap(Style.init(rawValue:)) {
            options.diffStyle = saved
        }
        return options
    }

    static func remember(_ style: Style, in store: UserDefaults = HubDefaults.store) {
        store.set(style.rawValue, forKey: styleKey)
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
