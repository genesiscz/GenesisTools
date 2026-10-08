import Foundation

public enum WidgetJSON: Codable, Sendable, Equatable, ExpressibleByStringLiteral,
    ExpressibleByBooleanLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral
{
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: WidgetJSON])
    case array([WidgetJSON])
    case null
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(dictionaryLiteral elements: (String, WidgetJSON)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
    public init(arrayLiteral elements: WidgetJSON...) { self = .array(elements) }
    public init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() {
            self = .null
        } else if let value = try? box.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? box.decode(String.self) {
            self = .string(value)
        } else if let value = try? box.decode(Double.self) {
            self = .number(value)
        } else if let value = try? box.decode([String: WidgetJSON].self) {
            self = .object(value)
        } else {
            self = .array(try box.decode([WidgetJSON].self))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .string(let value): try box.encode(value)
        case .number(let value): try box.encode(value)
        case .bool(let value): try box.encode(value)
        case .object(let value): try box.encode(value)
        case .array(let value): try box.encode(value)
        case .null: try box.encodeNil()
        }
    }
    public static func value<T: Encodable>(_ value: T) throws -> WidgetJSON {
        try JSONDecoder().decode(WidgetJSON.self, from: JSONEncoder().encode(value))
    }
}

public struct WidgetTarget: Codable, Equatable, Sendable {
    public var hostId: String
    public var provider: String
    public var sessionId: String
    public var sourceHome: String
    public var cwd: String
    public func hasSameIdentity(as other: WidgetTarget?) -> Bool {
        guard let other else { return false }
        return hostId == other.hostId && provider == other.provider && sessionId == other.sessionId
            && sourceHome == other.sourceHome
    }
}
public struct WidgetSession: Codable, Identifiable, Equatable, Sendable {
    public var key: String
    public var target: WidgetTarget
    public var title: String
    public var project: String
    public var activityAt: Double
    public var status: String
    public var pinned: Bool
    public var visible: Bool
    public var hiddenByFilter: Bool
    public var parentSessionId: String?
    public var agentId: String?
    public var transcriptPath: String?
    public var parentKey: String?
    public var role: String?
    public var model: String?
    public var account: String?
    public var startedAt: Double?
    public var toolCalls: Int?
    public var agentStatus: String?
    public var id: String { key }
    public var visualStatus: AgentWidgetStatus {
        switch status {
        case "working": return .working
        case "waiting": return .waiting
        case "finished": return .finished
        default: return .recent
        }
    }
}
public struct WidgetChoice: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var recommended: Bool
}
public struct WidgetFormChoice: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var label: String
}
public struct WidgetFormItem: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var promptMarkdown: String
    public var choices: [WidgetFormChoice]?
    public var allowMultiple: Bool?
    public var allowFreeText: Bool?
    public var allowFileTags: Bool?
    public var allowImagePaste: Bool?
    public var required: Bool?
}
public struct WidgetFormAnswer: Codable, Equatable, Sendable {
    public var itemId: String
    public var freeText: String?
    public var selectedChoices: [String]?
    public var fileTags: [String]?
    public var mediaContext: String?
}
public struct WidgetImageReference: Codable, Identifiable, Equatable, Sendable {
    public struct Comparison: Codable, Equatable, Sendable {
        public var group: String
        public var role: String
    }
    public var id: String
    public var path: String
    public var name: String
    public var width: Int
    public var height: Int
    public var label: String?
    public var comparison: Comparison?
}
public struct WidgetReference: Codable, Equatable, Sendable {
    public var type: String
    public var value: String
}
public struct WidgetCard: Codable, Identifiable, Equatable, Sendable {
    public var sourceContext: WidgetSourceContext? = nil
    public var transcriptAnchor: WidgetTranscriptAnchor? = nil
    public var id: String
    public var kind: String
    public var sessionKey: String
    public var sourceId: String
    public var at: Double
    public var title: String
    public var body: String
    public var status: String
    public var revision: Int?
    public var number: Int?
    public var choices: [WidgetChoice]
    public var formItems: [WidgetFormItem]?
    public var formAnswers: [String: WidgetFormAnswer]?
    public var attachments: [WidgetImageReference]
    public var refs: [WidgetReference]
    public var read: Bool
    public var entryId: String?
    public var needsAnswer: Bool {
        (kind == "decision" && ["open", "drafted"].contains(status))
            || (kind == "form" && status == "pending")
    }
}
public struct WidgetVideoSettings: Codable, Equatable, Sendable {
    public var fps: Int
    public var framesPerImage: Int
    public var minimumDifferencePct: Double
    public var startUs: Double? = nil
    public var endUs: Double? = nil

    func sampleRange(durationUs: Double) -> ClosedRange<Double> {
        let duration = max(1, durationUs)
        let end = min(duration, max(1, endUs ?? duration))
        let start = min(end - 1, max(0, startUs ?? 0))
        return start...end
    }

    mutating func setSampleStart(seconds: Double, durationUs: Double) {
        guard seconds.isFinite, durationUs > 0 else { return }
        let range = sampleRange(durationUs: durationUs)
        let value = max(0, min((seconds * 1_000_000).rounded(), range.upperBound - min(10_000, durationUs)))
        startUs = value == 0 ? nil : value
    }

    mutating func setSampleEnd(seconds: Double, durationUs: Double) {
        guard seconds.isFinite, durationUs > 0 else { return }
        let range = sampleRange(durationUs: durationUs)
        let value = min(durationUs, max((seconds * 1_000_000).rounded(), range.lowerBound + min(10_000, durationUs)))
        endUs = value == durationUs ? nil : value
    }
}
public struct WidgetAsset: Codable, Identifiable, Equatable, Sendable {
    public struct Progress: Codable, Equatable, Sendable {
        public var phase: String
        public var completed: Int
        public var total: Int
    }
    public var id: String
    public var type: String
    public var name: String
    public var path: String
    public var sha256: String
    public var width: Int
    public var height: Int
    public var bytes: Int?
    public var mimeType: String?
    public var durationUs: Double?
    public var settings: WidgetVideoSettings?
    public var revision: Int?
    public var confirmedRevision: Int?
    public var status: String?
    public var manifestPath: String?
    public var error: String?
    public var progress: Progress?
}
public struct WidgetCounts: Codable, Equatable, Sendable {
    public var candidates: Int
    public var kept: Int
    public var skipped: Int
    public var images: Int
    public var lastImageFrames: Int
}
public struct WidgetVideoManifest: Codable, Equatable, Sendable {
    public struct Frame: Codable, Identifiable, Equatable, Sendable {
        public var id: String
        public var requestedUs: Double
        public var actualUs: Double
        public var path: String
        public var kept: Bool
        public var differencePct: Double?
        public var comparedToId: String?
    }
    public struct Sheet: Codable, Identifiable, Equatable, Sendable {
        public var path: String
        public var frameIds: [String]
        public var firstUs: Double
        public var lastUs: Double
        public var id: String { path }
    }
    public var id: String
    public var frames: [Frame]
    public var sheets: [Sheet]
    public var counts: WidgetCounts
    public var settings: WidgetVideoSettings
}
public struct WidgetDraft: Codable, Equatable, Sendable {
    public var text: String = ""
    public var assetIds: [String] = []
    public init(text: String = "", assetIds: [String] = []) {
        self.text = text
        self.assetIds = assetIds
    }
}
public struct WidgetPreferences: Codable, Equatable, Sendable {
    public var excludedKeys: [String]
    public var projects: [String]
    public var sessions: [String]
    public var showChanges: Bool
    /// "Show the widget". A state saved before the switch existed has no key, and nil means off.
    public var showWidget: Bool?
    public var placement: String
    public var side: String
    public var topModules: [String]?
    public var sideGroups: [[String]]?
    public var sideLayout: String?
    public var sidePosition: Double?
    public var hoverPreviews: Bool?
    public var sideStyle: String?
    public var joinedEdges: Bool?
    public var glassEffect: Bool?
    public var display: String?
    public var providers: [String]?

    public var layout: WidgetLayoutConfiguration {
        WidgetLayoutConfiguration(
            topModules: topModules ?? ["agents"],
            sideGroups: sideGroups ?? [["agents"], ["capture", "shelf"], ["focus", "voice", "tasks"]],
            separated: sideLayout == "separated", sidePosition: sidePosition ?? 0.5,
            hoverPreviews: hoverPreviews ?? true)
    }
    public var quietSeconds: Int
    public var voiceProvider: String
    public var voiceAccount: String?
    public var voiceModel: String?
    public var voiceLanguage: String
}
public struct WidgetOutgoing: Codable, Identifiable, Equatable, Sendable {
    public struct Receipt: Codable, Equatable, Sendable {
        public var channel: String
        public var delivered: Bool
        public var at: Double
        public var detail: String?
        public var entryId: String?
    }
    public var id: String
    public var target: WidgetTarget
    public var payload: WidgetJSON
    public var assetIds: [String]
    public var createdAt: Double
    public var sequence: Int
    public var state: String
    public var error: String?
    public var receipt: Receipt?
    public var dispatchedAt: Double?
    /// The composer text. A form sent without any keeps a "Form answer" label, because its payload stores `text: ""`.
    public var text: String {
        guard case .object(let fields) = payload, case .string(let value) = fields["text"],
            fields["kind"] != .string("form") || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return "Form answer"
        }
        return value
    }
    public var isSettled: Bool { state == "sent" || state == "cancelled" }
    /// Not yet in delivery, so the hub still lets the user edit or cancel it (`changeOutgoing`). A preparing or
    /// review message blocks its conversation, so these controls must not wait for a failure.
    public var isWithdrawable: Bool { ["preparing", "review", "queued", "failed", "waiting-route"].contains(state) }
    /// Delivery stopped and needs the user: Retry and another destination are offered.
    public var needsRecovery: Bool { ["failed", "waiting-route", "unknown"].contains(state) }
    public static let shownHistory = 20
    /// The last 20 messages plus every older unsettled one: an unsettled message blocks its whole conversation, so
    /// its Retry, Edit and review controls must stay reachable. Mirrors `shownOutgoing` in src/hub/lib/widget/types.ts.
    public static func shown(_ messages: [WidgetOutgoing]) -> [WidgetOutgoing] {
        let start = messages.count - shownHistory
        return messages.enumerated().filter { $0.offset >= start || !$0.element.isSettled }.map(\.element)
    }
}
public struct WidgetState: Codable, Equatable, Sendable {
    public var version: Int
    public var revision: Int
    public var selectedKey: String?
    public var preferences: WidgetPreferences
    public var assets: [String: WidgetAsset]
    public var drafts: [String: WidgetDraft]
    public var outgoing: [WidgetOutgoing]
}
public struct WidgetActivityEvent: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var sourceId: String
    public var at: Double
    public var title: String
    public var body: String
}

public struct WidgetInboxItem: Codable, Equatable, Sendable {
    public var id: String
    public var sourceId: String
    public var kind: String
    public var key: String
    public var at: Double
    public var needsAnswer: Bool
}
public struct WidgetInboxSession: Codable, Equatable, Sendable {
    public var key: String
    public var unread: Int
    public var needsAnswer: Int
    public var latest: WidgetInboxItem?
    public var unreadItem: WidgetInboxItem?
    public var pendingItem: WidgetInboxItem?
}
public struct WidgetInboxSummary: Codable, Equatable, Sendable {
    public struct Profile: Codable, Equatable, Sendable { public var hostId: String }
    public var unread: Int
    public var needsAnswer: Int
    public var complete: Bool
    public var truncated: Bool
    public var sessions: [WidgetInboxSession]
    public var profile: Profile?
    public static let empty = WidgetInboxSummary(unread: 0, needsAnswer: 0, complete: false, truncated: false, sessions: [])
}

public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public var notifications: WidgetInboxSummary? = nil
    public struct Changes: Codable, Equatable, Sendable {
        public struct File: Codable, Identifiable, Equatable, Sendable {
            public var path: String
            public var at: String
            public var source: String
            public var id: String { path }
        }
        public var available: Bool
        public var files: [File]
    }
    public var version: Int
    public var state: WidgetState
    public var sessions: [WidgetSession]
    public var cards: [WidgetCard]
    public var activity: [WidgetActivityEvent]?
    public var manifests: [String: WidgetVideoManifest]
    public var changes: Changes?
    public var errors: [String]
    public var selectedKey: String?
}

public enum WidgetSelection {
    public static func initial(persisted: String?, visibleKeys: [String]) -> String {
        if let persisted, !persisted.isEmpty { return persisted }
        return visibleKeys.first ?? ""
    }
}

public struct WidgetSourceContext: Codable, Equatable, Sendable {
    public var sessionId: String
    public var agent: String?
    public var agentLabel: String?
    public var aiAgent: String?
    public var project: String?
    public var cwd: String?
    public var repoRoot: String?
    public var branch: String?
    public var commitSha: String?
    public var isWorktree: Bool?
    public var worktreePath: String?
}

public struct WidgetTranscriptAnchor: Codable, Equatable, Sendable {
    public var kind: String
    public var provider: String?
    public var sessionId: String?
    public var receivedAt: Double
    public var messageId: String?
    public var turnId: String?
    public var toolCallId: String?
}

public struct WidgetReceiptContext: Codable, Equatable, Sendable {
    public struct Window: Codable, Equatable, Sendable {
        public var status: String
        public var detail: String
        public var before: [TranscriptTurn]
        public var around: [TranscriptTurn]
        public var after: [TranscriptTurn]
        public var bytesRead: Int
        public var fileSize: Int
        public var truncated: Bool
        public var skippedLines: Int
        public var anchorOffset: Int?
    }
    public var id: String
    public var sourceContext: WidgetSourceContext?
    public var transcriptAnchor: WidgetTranscriptAnchor
    public var transcript: Window?
    public var error: String?
}
