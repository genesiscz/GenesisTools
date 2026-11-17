import Foundation

/// Where a session lives (a cmux pane, a T3 Code thread) and what its buttons can do there: `host` of one
/// `tools ai session-host describe --json` answer (GenesisTools `src/ai/lib/session-host/types.ts`,
/// `SessionHostView`). The kind is a string, so a host GenesisTools adds later decodes without a change here.
public struct SessionHostPlace: Equatable, Sendable, Codable {
    /// One button's state: enabled with its tooltip, or disabled with the reason a user reads.
    public struct ActionState: Equatable, Sendable, Codable {
        public var enabled: Bool
        public var tip: String?
        public var reason: String?

        public init(enabled: Bool, tip: String? = nil, reason: String? = nil) {
            self.enabled = enabled
            self.tip = tip
            self.reason = reason
        }

        /// The tooltip: the tip when enabled, else the reason.
        public var help: String { (enabled ? tip : reason) ?? "" }
    }

    public struct Actions: Equatable, Sendable, Codable {
        public var focus: ActionState
        public var wake: ActionState
        public var keepalive: ActionState

        public init(focus: ActionState, wake: ActionState, keepalive: ActionState) {
            self.focus = focus
            self.wake = wake
            self.keepalive = keepalive
        }
    }

    /// `cmux`, `t3`, or a later host.
    public var kind: String
    /// The kind of place, for a sentence: "cmux pane", "T3 Code thread".
    public var place: String
    /// This place: the pane's workspace and tab, the thread's title.
    public var label: String
    /// true: the agent works there now. false: known but idle or closed. nil: the host cannot tell.
    public var live: Bool?
    /// One line on the state: "Waiting in a cmux pane", "A turn runs in its T3 Code thread".
    public var note: String
    public var actions: Actions

    public init(kind: String, place: String, label: String, live: Bool? = nil, note: String = "", actions: Actions) {
        self.kind = kind
        self.place = place
        self.label = label
        self.live = live
        self.note = note
        self.actions = actions
    }

    /// The sidebar symbol of each host kind; a kind this build does not know gets the generic one.
    static let symbols: [String: String] = [
        "cmux": "rectangle.split.2x1",
        "t3": "bubble.left.and.text.bubble.right",
    ]

    public var symbol: String { Self.symbols[kind] ?? "macwindow" }
}

/// One session's answer from `tools ai session-host describe --json`: its host, or the reason none holds it.
public struct SessionHostAnswer: Equatable, Sendable, Codable {
    public var sessionId: String
    public var host: SessionHostPlace?
    /// Set when `host` is nil: "No T3 Code thread or cmux pane holds this session."
    public var reason: String?

    public init(sessionId: String, host: SessionHostPlace? = nil, reason: String? = nil) {
        self.sessionId = sessionId
        self.host = host
        self.reason = reason
    }
}

/// The envelope `tools ai session-host describe --json` prints.
public struct SessionHostAnswers: Equatable, Sendable, Codable {
    public var answers: [SessionHostAnswer]

    public init(answers: [SessionHostAnswer]) {
        self.answers = answers
    }
}

/// The result `tools ai session-host <focus|wake|keepalive> --json` prints.
public struct SessionHostActResult: Equatable, Sendable, Codable {
    public var ok: Bool
    public var detail: String?
    public var reason: String?
    public var host: SessionHostPlace?

    public init(ok: Bool, detail: String? = nil, reason: String? = nil, host: SessionHostPlace? = nil) {
        self.ok = ok
        self.detail = detail
        self.reason = reason
        self.host = host
    }
}
