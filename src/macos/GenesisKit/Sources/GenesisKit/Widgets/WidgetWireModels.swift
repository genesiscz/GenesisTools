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
    /// The decision that replaced this one (`question_update` with `supersededBy`).
    public struct SupersededBy: Codable, Equatable, Sendable {
        public var id: String
        public var number: Int
        public var sessionKey: String?
        public var title: String?
    }
    /// A decision's recorded answer: the option letters, the text, and who recorded it ("inbox" or "agent").
    public var option: String? = nil
    public var answer: String? = nil
    public var answeredVia: String? = nil
    public var comments: [String]? = nil
    public var supersededBy: SupersededBy? = nil
    /// A staged decision's unsent pick and note (the decision log's `drafted` state); sent with the other staged ones.
    public var draftOption: String? = nil
    public var draft: String? = nil
    public var isStaged: Bool { kind == "decision" && needsAnswer && (draftOption != nil || draft != nil) }
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
    /// "dark", "glass" or "theme"; nil reads as "dark".
    public var panelBackground: String?
    /// The hover list's rows show their waiting question; nil reads as on.
    public var previewQuestion: Bool?
    public var display: String?
    public var providers: [String]?
    /// Widget alerts for new items: a chime (`alertSound`, a system sound name or "none") and a popup.
    public var alertDecisions: Bool?
    public var alertAnswers: Bool?
    public var alertSound: String?
    public var alertPopup: Bool?
    /// The agents hover list: "needs-you" (default) or "active" (sessions that work now too).
    public var previewFilter: String?
    /// The agents hover list's order: "attention" (default), "recent" or "project".
    public var previewSort: String?
    /// An answer's sound: "same" (default, `alertSound`), "none" or a system sound name.
    public var alertAnswerSound: String?
    /// Seconds the session that raised an alert flashes; 0 does not flash it. Default 5.
    public var alertFlashSeconds: Double?
    /// A session inbox's composer: "top" (default, under the tabs) or "bottom".
    public var inboxComposer: String?
    /// A rail bubble's tooltip: "auto" (default, only without hover previews), "always" or "never".
    public var bubbleTooltip: String?
    /// The rail's session bubbles: "list" (default, the hover list's order) or "stable" (each keeps its place).
    public var railOrder: String?
    /// A click on a decision option: "stage" (default, sent later with the other staged ones) or "send" (at once).
    public var decisionClick: String?
    /// ⌘-click on an option and ⌘-Return in a decision's own answer do the other action. Default true.
    public var decisionCommandSwaps: Bool?
    /// Return in a decision's own answer field: "stage" (default, the text becomes its note) or "send".
    public var ownAnswerReturn: String?
    /// At start, a popup lists the staged decisions with Send now until it is closed. Default true.
    public var stagedReminder: Bool?
    /// Leaving the inbox with staged decisions: "ask" (default), "keep" or "send".
    public var stagedOnLeave: String?
    /// Seconds to show a delivered note before a send-and-close folds the panel; 0 keeps it open. Default 2.5.
    public var sendCloseSeconds: Double?
    /// The inbox of every session: "session" (default, grouped under each session) or "list".
    public var inboxGrouping: String?
    /// The filter a session's inbox opens with: "all" (default), "inbox" or "decisions".
    public var inboxFilter: String?
    /// The filter the inbox of every session opens with: "all" (default), "needs" or "unread".
    public var overviewFilter: String?
    /// The composer's microphone: "note" (default, a voice note whose transcript fills the field) or "live".
    public var composerVoice: String?
    /// Seconds the alert popup stays when the pointer is not on it; 0 keeps it until it is closed. Default 7.
    public var alertPopupSeconds: Double?
    /// A click outside the widget closes the alert popup. Default off.
    public var alertPopupClickAway: Bool?
    /// Another alert while the popup is open: "list" (default, listed under it), "queue" (after it) or "newest".
    public var alertPopupMany: String?
    /// After a pick sent from the alert popup: "stay" (default, the popup shows its result) or "session" (opens it).
    public var popupSendOpens: String?
    /// The alert sounds' volume in percent of the system volume. Default 100.
    public var alertVolume: Double?
    /// A decision answered outside the widget pops up with a sound (Automatic decisions). Default on.
    public var autoDecisionPopup: Bool?
    /// Seconds that popup stays while the pointer is not on it; 0 keeps it until it is closed. Default 5.
    public var autoDecisionSeconds: Double?
    /// Its sound: a system sound name, "same" (`alertSound`) or "none". Default "Tink".
    public var autoDecisionSound: String?
    /// Seconds a widget note stays before it fades; 0 keeps it until it is closed. Default 6. A note with a button
    /// stays at least 10 s.
    public var noteSeconds: Double?
    /// A global shortcut opens and closes the widget (`openShortcut`). Default on, with ⌃⌥⌘W.
    public var openShortcutEnabled: Bool?
    /// The shortcut, as a Carbon key code and modifier mask (`HotkeyChord`).
    public var openShortcut: WidgetShortcutChord?

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
/// A global shortcut as the widget preferences store it: a Carbon virtual key code and a Carbon modifier mask.
public struct WidgetShortcutChord: Codable, Equatable, Sendable {
    public var keyCode: UInt32
    public var modifiers: UInt32

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// ⌃⌥⌘W: the dictation shortcut's family (⌃⌥⌘D), and no macOS or common app shortcut.
    public static let defaultOpen = WidgetShortcutChord(
        keyCode: 0x0D, modifiers: HotkeyChord.control | HotkeyChord.option | HotkeyChord.command)

    public var hotkey: HotkeyChord { HotkeyChord(keyCode: keyCode, modifiers: modifiers) }
}

extension WidgetPreferences {
    /// The shortcut that opens the widget, or nil while it is off. A stored chord without ⌘, ⌥ or ⌃ would take a
    /// plain key from every app, so the default stands in for it.
    public var openShortcutChord: WidgetShortcutChord? {
        guard openShortcutEnabled ?? true else { return nil }
        let chord = openShortcut ?? .defaultOpen
        let required = HotkeyChord.command | HotkeyChord.option | HotkeyChord.control
        return chord.modifiers & required != 0 ? chord : .defaultOpen
    }
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
    /// Its attachments are already serialized and must not change in place: dispatching, sent,
    /// unknown, or waiting for a route behind a session-queue reservation. Mirrors `assertEditable`
    /// in `src/hub/lib/composer/assets.ts`.
    public var freezesAssets: Bool {
        ["dispatching", "sent", "unknown"].contains(state)
            || (state == "waiting-route" && receipt?.channel == "session-queue")
    }
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
    /// A decision link asked the running widget to show this decision (`tools hub widget show-decision`).
    public var showDecision: WidgetShowDecision?
}
public struct WidgetShowDecision: Codable, Equatable, Sendable {
    public var id: String
    public var at: Double
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
    /// A short title (a decision's title or prompt, an answer's question) and a decision's number, for alerts.
    public var title: String? = nil
    public var number: Int? = nil
    /// How many items this entry stands for: an answers group lists only its newest item.
    public var count: Int? = nil
    /// A decision's options and recommended letter, so the inbox of every session can stage a pick in place.
    public var options: [String]? = nil
    public var recommended: String? = nil
    public var revision: Int? = nil
    /// A staged decision's unsent pick and note; see `WidgetCard.draftOption`.
    public var draftOption: String? = nil
    public var draft: String? = nil
    /// A decision answered outside the widget (`WidgetInboxSummary.answeredElsewhere`): the chosen letters, the
    /// answer, and who stored it ("agent" or "automatic_heuristic").
    public var option: String? = nil
    public var answer: String? = nil
    public var answeredVia: String? = nil
    public var isStaged: Bool { kind == "decision" && needsAnswer && (draftOption != nil || draft != nil) }
    public var isAnsweredElsewhere: Bool { kind == "decision" && !needsAnswer && answeredVia != nil }
}
public struct WidgetInboxSession: Codable, Equatable, Sendable {
    public var key: String
    public var unread: Int
    public var needsAnswer: Int
    public var latest: WidgetInboxItem?
    public var unreadItem: WidgetInboxItem?
    public var pendingItem: WidgetInboxItem?
    /// The session's listed entries for the inbox overview, waiting ones first, then newest; nil from an older hub.
    public var items: [WidgetInboxItem]? = nil
}
public struct WidgetInboxSummary: Codable, Equatable, Sendable {
    public struct Profile: Codable, Equatable, Sendable { public var hostId: String }
    public var unread: Int
    public var needsAnswer: Int
    public var complete: Bool
    public var truncated: Bool
    public var sessions: [WidgetInboxSession]
    /// Every staged decision, uncapped (a session's `items` stop at eight); nil from an older hub.
    public var staged: [WidgetInboxItem]? = nil
    /// Decisions answered outside the widget in the last week, newest first, at most 20; nil from an older hub.
    public var answeredElsewhere: [WidgetInboxItem]? = nil
    /// Uncapped pending decision IDs; absent from older hubs. Only complete snapshots are authoritative.
    public var pendingDecisionIDs: [String]? = nil
    public var profile: Profile?
    public static let empty = WidgetInboxSummary(unread: 0, needsAnswer: 0, complete: false, truncated: false, sessions: [])
}

public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public var notifications: WidgetInboxSummary? = nil
    public var rosterLoading: Bool? = nil
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
    /// Other sessions whose cards this snapshot carries too (the ones that need you), so opening one waits for nothing.
    public var warmKeys: [String]? = nil
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

/// A numbered decision shows its number wherever its title shows: "DECISION 20: Which mods to build next" (Martin,
/// 2026-10-23: "i dont see decision number anywhere around this and i should"). The chat, the log and the widget
/// then name it the same way.
public enum WidgetDecisionTitle {
    public static func numbered(_ title: String, number: Int?) -> String {
        number.map { "DECISION \($0): " + title } ?? title
    }
}

public extension WidgetCard {
    var numberedTitle: String { WidgetDecisionTitle.numbered(title, number: number) }
}

public extension WidgetInboxItem {
    var numberedTitle: String? { title.map { WidgetDecisionTitle.numbered($0, number: number) } }
}
