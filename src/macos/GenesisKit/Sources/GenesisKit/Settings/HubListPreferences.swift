import Foundation

// What the hub's lists leave out when it repeats, and how much of a long thing they show at first (hub UX wave 1b,
// 2026-11-10). Both faces read and write the keys through `@AppStorage`; the controls are on Settings → Hub → Panes.

/// The Sessions list's rows.
public enum HubSessionRows {
    /// A project, account or app chip that every row of a group shows is left out of that group's rows (the group
    /// header or the other rows already say it). On by default: each row repeated the same chips (hub UX C8).
    public static let hideSharedKey = "hub.sessions.hideShared"
}

/// When a PR row shows its CI icon. The readiness word ("ready", "2 open", "checks failed") is the row's status; the
/// CI icon beside it repeated a red mark on nearly every row of a project whose checks usually fail (hub UX C9).
public enum HubPRRowCI: String, CaseIterable, Identifiable, Sendable {
    case unusual, always
    public static let key = "hub.prs.rowCI"
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .unusual: return "When it differs"
        case .always: return "Always"
        }
    }

    public var detail: String {
        switch self {
        case .unusual: return "A row shows CI only when it differs from most of the project's PRs, or when nothing else on the row says it."
        case .always: return "Every row shows its CI icon."
        }
    }

    /// Unset or unknown reads as `unusual`.
    public static func stored(_ raw: String) -> HubPRRowCI { HubPRRowCI(rawValue: raw) ?? .unusual }
}

/// The page a PR detail opens on in the redesign layouts (`--sketch prDetail=a|b`). `auto` keeps each layout's own
/// first page: Threads while the review's threads list setting is on, else About (A) or the diff (B).
public enum HubPRDetailOpeningTab: String, CaseIterable, Identifiable, Sendable {
    case auto, overview, changes, threads
    public static let key = "hub.prs.detail.openingTab"
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .auto: return "Auto"
        case .overview: return "Overview"
        case .changes: return "Changes"
        case .threads: return "Threads"
        }
    }

    public var detail: String {
        switch self {
        case .auto: return "Threads while the threads list is open in reviews, else the layout's first page."
        case .overview: return "The description and the agent sessions on the PR."
        case .changes: return "The diff and its changed files."
        case .threads: return "The PR's review threads."
        }
    }

    /// Unset or unknown reads as `auto`.
    public static func stored(_ raw: String?) -> HubPRDetailOpeningTab { raw.flatMap(HubPRDetailOpeningTab.init(rawValue:)) ?? .auto }
}

/// Whether resting the pointer on a PR row whose CI failed loads that PR's checks, so the row's tooltip names the
/// failed ones before its detail was ever opened (hub UX C9). One load per PR head: a push asks again.
public enum HubPRRowHoverChecks: String, CaseIterable, Identifiable, Sendable {
    case onRest, never
    public static let key = "hub.prs.hoverChecks"
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .onRest: return "On hover"
        case .never: return "Never"
        }
    }

    public var detail: String {
        switch self {
        case .onRest: return "Resting the pointer on a row whose CI failed loads its checks once per push, so the tooltip names the failed ones."
        case .never: return "The tooltip names the failed checks only after the PR was opened."
        }
    }

    /// Unset or unknown reads as `onRest`.
    public static func stored(_ raw: String) -> HubPRRowHoverChecks { HubPRRowHoverChecks(rawValue: raw) ?? .onRest }
}

/// The Files tree of a review (the hub's Changed list and the review window's file list).
public enum HubFileTreeFold {
    /// A folder with more changed files than this starts folded, unless it holds half of the list or more (the one
    /// folder most of a change is in stays open). 0 never folds. Expanded media folders filled the tree (hub UX C26).
    public static let key = "hub.files.foldAbove"
    public static let defaultAbove = 20
    public static let range = 0...500

    /// Unset reads as the default; a stored value outside the range reads as its nearest limit.
    public static func stored(in defaults: UserDefaults) -> Int {
        guard defaults.object(forKey: key) != nil else { return defaultAbove }
        return min(range.upperBound, max(range.lowerBound, defaults.integer(forKey: key)))
    }
}

/// How many lines of a tool call's output the transcript shows before "… +N lines", at every level that shows output
/// (Verbose included). Long `--help` and log output filled the reading column (hub UX C18). 0 folds only at the
/// level's own limit, and Verbose then shows every line.
public enum TranscriptOutputFold {
    public static let key = "sessionTranscript.outputFold"
    public static let defaultLines = 6
    public static let range = 0...200

    /// The fold for a stored value: nil when it is off.
    public static func lines(_ stored: Int) -> Int? {
        stored > 0 ? min(range.upperBound, stored) : nil
    }
}

/// The band under the hub's title bar.
public enum HubChrome {
    /// The Glass button beside Settings. Off by default: glass is a look picked once, and it stays in View → Glass
    /// (⌘⇧G), the command palette and Settings → Hub → Appearance (hub UX C2).
    public static let glassButtonKey = "hub.chrome.glassButton"
}
