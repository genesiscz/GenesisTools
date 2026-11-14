import Foundation

/// What a hub mode with a model of its own (PRs, Inbox, Activity, Agents, Usage) answers about itself. `HubModel` asks
/// the model of a mode through `owner(of:)`, the one table keyed by `HubMode`, so a new mode with its own model adopts
/// this protocol and adds one row there.
///
/// Only facts that each of the five answers from its own state are here. These stay in `HubModel`'s switches: the
/// activation (the PRs list needs the session folders), the restore of a place (PRs keeps its linked commit and its
/// notices in `HubModel`) and the snapshot's wait for a diff (Agents reads the shared panes and review).
@MainActor
protocol HubModeModel: AnyObject {
    /// The selection of the mode's history entry and saved place. Nil while nothing is picked, which makes the place
    /// provisional; a mode whose list is the content itself answers `HubModel.wholeList` then.
    var navSelection: String? { get }
    /// What the mode's place with `selection` shows, for the Back and Forward tooltips and the History list.
    func navTitle(selection: String) -> String
    /// The main view on screen has a `TitlebarHeader`, so its first row belongs in the title bar; an empty state
    /// ("Pick a PR or MR") has none. The `--snapshot` title bar audit reads it.
    var showsTitlebarHeader: Bool { get }
    /// View → Reload: read the mode's list again.
    func reload()
}

/// Who answers for a hub mode (`HubModel.owner(of:)`).
enum HubModeOwner {
    /// Sessions and Worktrees live in `HubModel`: they share the review slot, the panes and the session list.
    case sessions, worktrees
    /// The other modes have a model of their own.
    case model(any HubModeModel)
}

extension HubModel {
    /// The one table keyed by `HubMode`. No `default`: a new mode is a compile error here.
    @MainActor
    func owner(of mode: HubMode) -> HubModeOwner {
        switch mode {
        case .sessions: return .sessions
        case .worktrees: return .worktrees
        case .prs: return .model(prs)
        case .inbox: return .model(inbox)
        case .timeline: return .model(timeline)
        case .agents: return .model(agents)
        case .usage: return .model(usage)
        }
    }
}
