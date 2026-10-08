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

    public var statusLabel: String {
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
