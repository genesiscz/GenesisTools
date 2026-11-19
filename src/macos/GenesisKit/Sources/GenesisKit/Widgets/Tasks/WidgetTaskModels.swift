import Foundation

public struct WidgetTask: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var number: Int
    public var title: String
    public var summary: String
    public var truncated: Bool
    public var revision: Int
    public var state: String
    public var updatedTs: String
    public var createdTs: String?
    public var blocking: Bool
    public var owner: String?
    public var sessionId: String
    public var provider: String
    public var sessionTitle: String?
    public var sourceContext: WidgetSourceContext

    public var sendUncertain: Bool? = nil
    public var workRef: String?
    public var acceptance: String?
    public var fullTitle: String?
    public var fullText: String?
    public var addressee: String { owner?.lowercased() == "human" ? "For you" : "For agent" }
    public var statusLabel: String { Self.label(for: state) }
    public static func label(for state: String) -> String {
        switch state {
        case "open": return "To do"
        case "acknowledged": return "In progress"
        case "implemented": return "Completed"
        case "dismissed": return "Dismissed"
        default: return state.capitalized
        }
    }
    public var actions: [WidgetTaskAction] {
        switch state {
        case "open": return [.acknowledge, .complete, .dismiss] + assignmentActions
        case "acknowledged": return [.complete, .dismiss] + assignmentActions
        case "implemented", "dismissed": return [.reopen]
        default: return []
        }
    }
    private var assignmentActions: [WidgetTaskAction] {
        if sendUncertain == true { return [.take] }
        guard !isLocal, provider != "unknown" else { return [] }
        if owner?.lowercased() == "human" { return [.send] }
        return state == "open" ? [.send, .take] : [.take]
    }
    /// The one-click action of the row's checkbox: tick an unfinished task done, untick a finished one.
    public var toggleAction: WidgetTaskAction? {
        switch state {
        case "open", "acknowledged": return .complete
        case "implemented", "dismissed": return .reopen
        default: return nil
        }
    }
    /// Only an open task's text can change; a taken or finished task keeps what was agreed. A task the widget shows as
    /// an excerpt is not editable here either: saving the excerpt would cut the stored text to it.
    public var editable: Bool { state == "open" && !truncated }
    /// Written in the widget without a session (`tools hub widget tasks create` without `--session`).
    public var isLocal: Bool { sessionId == WidgetTask.localSession }
    public static let localSession = "local"
}

public enum WidgetTaskAction: String, CaseIterable, Sendable {
    case acknowledge, complete, reopen, dismiss, send, take
    public var title: String {
        switch self {
        case .acknowledge: return "Acknowledge"
        case .complete: return "Complete"
        case .reopen: return "Reopen"
        case .send: return "Send to agent"
        case .take: return "Take it myself"
        case .dismiss: return "Dismiss"
        }
    }
    public func targetState(from current: String) -> String {
        switch self {
        case .acknowledge: return "acknowledged"
        case .complete: return "implemented"
        case .reopen: return "open"
        case .send: return "acknowledged"
        case .take: return current
        case .dismiss: return "dismissed"
        }
    }
    /// The actions that move a task back to `state`, in order; empty when there is no way back. The ledger has no
    /// move from done straight to in progress, so that one is a reopen and then an acknowledge.
    static func returning(to state: String) -> [WidgetTaskAction] {
        switch state {
        case "open": return [.reopen]
        case "acknowledged": return [.reopen, .acknowledge]
        case "implemented": return [.complete]
        case "dismissed": return [.dismiss]
        default: return []
        }
    }
}

/// What the create form holds between keystrokes; the session and project stay for the next task.
public struct WidgetTaskDraft: Equatable, Sendable {
    public var title = ""
    public var details = ""
    public var owner = "human"
    /// `provider:sessionId`, empty for a local task.
    public var session = ""
    public var sessionTitle = ""
    public var project = ""
    public var cwd = ""
    public init() {}
}

/// A session a new task can belong to: from the ledger's sessions and the widget's live roster.
public struct WidgetTaskSessionChoice: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var project: String
    public var cwd: String
}

/// The receipt of the last change, with the move that undoes it.
public struct WidgetTaskUndo: Equatable, Sendable {
    public var task: WidgetTask
    public var action: WidgetTaskAction
    /// A second step, run against the version the first one returned (back to in progress: reopen, then acknowledge).
    public var then: WidgetTaskAction? = nil
}

struct WidgetTaskSnapshot: Codable, Equatable, Sendable {
    struct Session: Codable, Identifiable, Equatable, Sendable {
        var id: String
        var title: String
    }
    var tasks: [WidgetTask]
    var total: Int
    var activeCount: Int
    var truncated: Bool
    var sourcePath: String
    var sourceStamp: String
    var projects: [String]
    var sessions: [Session]
    /// Per project, from the work store: items spotted, items reopened, outside changes held. Absent before the store.
    var work: [WidgetWorkCount]? = nil
    var claimedHandoffs: [WidgetClaimedHandoff]? = nil
    var additionalSourcePaths: [String]? = nil
}

struct WidgetClaimedHandoff: Codable, Equatable, Identifiable, Sendable {
    struct Claimant: Codable, Equatable, Sendable {
        var title: String
    }
    struct Member: Codable, Equatable, Sendable {
        var id: String
        var slot: String?
        var title: String
        var state: String
        var body: String?
        var acceptance: String?
        var repoRoot: String?
        var rowID: String { slot ?? id }
    }
    var id: String
    var project: String
    var title: String
    var claimants: [Claimant]
    var members: [Member]
    var body: String?
    var repoRoot: String?
}

/// One project's counts of the work store (work-items P8): what waits for a look, shown under the Tasks header.
public struct WidgetWorkCount: Codable, Equatable, Sendable, Identifiable {
    public var project: String
    public var spotted: Int
    public var reopened: Int
    public var held: Int
    public var id: String { project }

    /// "7 spotted · 1 reopened", the counts that are not zero; empty when all three are.
    public var summary: String {
        [(spotted, "spotted"), (reopened, "reopened"), (held, Plural.word(held, "held link"))]
            .filter { $0.0 > 0 }
            .map { "\($0.0) \($0.1)" }
            .joined(separator: " · ")
    }
}

struct WidgetTaskResumeRequest: Sendable {
    let task: WidgetTask
    let sourceHome: String?
    var id: String { task.id }
}

struct WidgetTaskUpdate: Codable, Sendable {
    struct Receipt: Codable, Sendable {
        var id: String
        var action: String
        var from: String
        var state: String
        var revision: Int
        var at: String
        var saved: Bool
        var needsResume: Bool? = nil
    }
    var task: WidgetTask
    var receipt: Receipt
}

/// `tasks create` and `tasks edit` answer with the saved task and a receipt.
struct WidgetTaskSaved: Codable, Sendable {
    struct Receipt: Codable, Sendable {
        var id: String
        var action: String
        var state: String
        var revision: Int
        var at: String
        var saved: Bool
    }
    var task: WidgetTask
    var receipt: Receipt
}
