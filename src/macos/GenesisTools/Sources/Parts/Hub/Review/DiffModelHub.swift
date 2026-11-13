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

/// The review page keeps the existing string encoding. Unknown and unprefixed IDs are
/// local comments, as the review's edit and send fallbacks have always treated them.
enum ReviewCardID: Equatable {
    case localComment(String)
    case proposalDraft(String)
    case threadReply(String)
    case liveThread(String)

    init(_ value: String) {
        if value.hasPrefix("draft:") {
            self = .proposalDraft(String(value.dropFirst("draft:".count)))
        } else if value.hasPrefix("thread:") {
            self = .threadReply(String(value.dropFirst("thread:".count)))
        } else if value.hasPrefix("live:") {
            self = .liveThread(String(value.dropFirst("live:".count)))
        } else {
            self = .localComment(value)
        }
    }

    var rawValue: String {
        switch self {
        case .localComment(let id): return id
        case .proposalDraft(let id): return "draft:\(id)"
        case .threadReply(let id): return "thread:\(id)"
        case .liveThread(let id): return "live:\(id)"
        }
    }

    // Navigation reads the page's kind tag, including IDs it cannot resolve locally.
    // Keep that boundary permissive, while the model parses the actual identity.
    static func isThreadKind(_ kind: String) -> Bool { kind == "thread" }
    static func isDraftKind(_ kind: String) -> Bool { kind == "draft" }

    var draftID: String? {
        guard case .proposalDraft(let id) = self else { return nil }
        return id
    }

    var threadID: String? {
        switch self {
        case .threadReply(let id), .liveThread(let id): return id
        case .localComment, .proposalDraft: return nil
        }
    }
}

/// Whether one card's send (For agent, Draft on PR, Post on PR, Promote) may start. The page drops a
/// card's send buttons once it went out, but a double click posts twice before the page redraws, and
/// Swift ran both: two drafts on the PR, or two agent comments. Swift checks the states the page
/// checks (main.ts `renderDraft`, `renderReply`, `renderComment`), plus a send still on its way.
enum SuggestionSendGate {
    /// `state` is what the page reads: a draft's status, a thread reply's `replyStatus`
    /// (nil until sent), or a local comment's state.
    static func refusal(card: ReviewCardID, state: String?, toPR: Bool, inFlight: Bool, busy: String?) -> String? {
        if inFlight {
            return "This suggestion is already on its way."
        }
        if toPR, let busy {
            return "\(busy) Wait until it finishes, then send again."
        }
        switch card {
        case .proposalDraft:
            if ["sent", "drafted", "posted"].contains(state ?? "") {
                return "This suggestion was already sent (\(state ?? ""))."
            }
        case .threadReply, .liveThread:
            if let state { return "This reply was already sent (\(state))." }
        case .localComment:
            if state == "posted" { return "This comment is already posted on the PR." }
        }
        return nil
    }
}
