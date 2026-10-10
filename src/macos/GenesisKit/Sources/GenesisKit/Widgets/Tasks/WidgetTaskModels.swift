import Foundation

public struct WidgetTask: Codable, Identifiable, Equatable, Sendable {
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
        case "open": return [.acknowledge, .complete, .dismiss]
        case "acknowledged": return [.complete, .dismiss]
        case "implemented", "dismissed": return [.reopen]
        default: return []
        }
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
    case acknowledge, complete, reopen, dismiss
    public var title: String {
        switch self {
        case .acknowledge: return "Acknowledge"
        case .complete: return "Complete"
        case .reopen: return "Reopen"
        case .dismiss: return "Dismiss"
        }
    }
    public var targetState: String {
        switch self {
        case .acknowledge: return "acknowledged"
        case .complete: return "implemented"
        case .reopen: return "open"
        case .dismiss: return "dismissed"
        }
    }
    /// The action that moves a task back to `state`, if the ledger allows that move.
    static func returning(to state: String) -> WidgetTaskAction? {
        switch state {
        case "open": return .reopen
        case "implemented": return .complete
        case "dismissed": return .dismiss
        default: return nil
        }
    }
}

/// What the create form holds between keystrokes; the session and project stay for the next task.
public struct WidgetTaskDraft: Equatable, Sendable {
    public var title = ""
    public var details = ""
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
