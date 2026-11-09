import Foundation

// MARK: - Decisions, the journal, review rows and comments: the Swift mirror of their Meetings service methods
// (src/meetings/lib/service/api.ts, decision-actions.ts, review-row-schema.ts, comment-schema.ts). The protocol fixture
// holds a real request and reply of each, and MeetingsServiceTests decodes them with these types.

/// Who made a decision (`decisionActorSchema`, src/utils/meetings/record.ts). `kind` is text, so a kind a newer service
/// adds still decodes (the service itself reads an unknown saved kind as `unknown`).
struct DecisionActor: Codable, Equatable, Hashable {
    /// window, listen, cli, agent, rule or unknown.
    let kind: String
    /// An agent's harness (`claude-code`, `codex`, …) and its session id (null when the harness names none).
    var harness: String?
    var session: String?
    /// A rule's name (`E2`).
    var rule: String?

    static let window = DecisionActor(kind: "window")

    init(kind: String, harness: String? = nil, session: String? = nil, rule: String? = nil) {
        self.kind = kind
        self.harness = harness
        self.session = session
        self.rule = rule
    }
}

/// One decision on a meeting (`decisionActionSchema` and the journal's own `revert` and `comment`), as one flat type:
/// each kind fills its own members and leaves the rest nil, which the encoder leaves out, so the strict schemas take it.
/// Item references take an id (`i42`) or `Q12`.
struct DecisionAction: Codable, Equatable, Hashable {
    /// confirm, reject, respell, answer, skip, split, rename, reopen, add, set, revert, comment (or a newer kind).
    var kind: String
    /// confirm, reject, reopen; revert: only these of the entry's items.
    var items: [String]?
    var minConfidence: Double?
    /// confirm: whose voice a speaker range is.
    var speaker: String?
    /// confirm: a term's right spelling.
    var proposed: String?
    /// respell: the item and its new text.
    var item: String?
    var text: String?
    /// answer, skip, split: the question; answer: the answer and its comment.
    var question: String?
    var answer: String?
    var comment: String?
    /// rename: a diarization label and its name for this meeting.
    var label: String?
    var name: String?
    /// set: the meeting's project, title, labels to add and to remove.
    var project: String?
    var title: String?
    var labels: [String]?
    var unlabel: [String]?
    /// revert: the entry it undoes.
    var token: String?

    init(kind: String) { self.kind = kind }

    static func confirm(_ items: [String], speaker: String? = nil, proposed: String? = nil) -> DecisionAction {
        var action = DecisionAction(kind: "confirm")
        action.items = items
        action.speaker = speaker
        action.proposed = proposed
        return action
    }

    static func reject(_ items: [String]) -> DecisionAction {
        var action = DecisionAction(kind: "reject")
        action.items = items
        return action
    }

    static func reopen(_ items: [String]) -> DecisionAction {
        var action = DecisionAction(kind: "reopen")
        action.items = items
        return action
    }

    static func respell(_ item: String, to text: String) -> DecisionAction {
        var action = DecisionAction(kind: "respell")
        action.item = item
        action.text = text
        return action
    }

    static func answer(_ question: String, _ answer: String, comment: String? = nil) -> DecisionAction {
        var action = DecisionAction(kind: "answer")
        action.question = question
        action.answer = answer
        action.comment = comment
        return action
    }

    static func skip(_ question: String) -> DecisionAction {
        var action = DecisionAction(kind: "skip")
        action.question = question
        return action
    }

    static func split(_ question: String) -> DecisionAction {
        var action = DecisionAction(kind: "split")
        action.question = question
        return action
    }

    static func rename(_ label: String, to name: String) -> DecisionAction {
        var action = DecisionAction(kind: "rename")
        action.label = label
        action.name = name
        return action
    }

    static func set(project: String? = nil, title: String? = nil, labels: [String]? = nil, unlabel: [String]? = nil) -> DecisionAction {
        var action = DecisionAction(kind: "set")
        action.project = project
        action.title = title
        action.labels = labels
        action.unlabel = unlabel
        return action
    }

    /// The item references this action names, for a row that waits for its result.
    var named: [String] {
        (items ?? []) + [item, question].compactMap { $0 }
    }
}

/// One item a decision changed: before (nil: the decision made it) and after (nil: it removed it).
struct ItemChange: Decodable, Equatable {
    let id: String
    let before: MeetingItem?
    let after: MeetingItem?
}

/// A speaker label's name before and after (nil: the source's own label).
struct LabelChange: Decodable, Equatable {
    let label: String
    let before: String?
    let after: String?
}

/// An item a decision named and left, with the reason; `needs` says what decides it (speaker, proposed, listen) or
/// `nothing` when it is decided that way already.
struct DecisionSkip: Decodable, Equatable, Hashable {
    let id: String
    let reason: String
    let needs: String?
}

/// One line of a meeting's decision journal (`journalEntrySchema`): who decided what, when and why, and every item it
/// changed, so its token undoes exactly it.
struct JournalEntry: Decodable, Equatable, Identifiable {
    let token: String
    let at: String
    let meeting: String
    let actor: DecisionActor
    let reason: String?
    let action: DecisionAction
    /// The question it decided (an answer, a skip, a split) or gave back.
    let question: String?
    let decided: [String]
    let settled: [String]
    let skipped: [DecisionSkip]
    let changes: [ItemChange]
    let labels: [LabelChange]
    /// `journal.read` only: the later entry that gave back every item this one decided.
    let revertedBy: String?

    var id: String { token }

    enum CodingKeys: String, CodingKey {
        case token, at, meeting, actor, reason, action, question, decided, settled, skipped, changes, labels, revertedBy
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        token = try container.decode(String.self, forKey: .token)
        at = try container.decode(String.self, forKey: .at)
        meeting = try container.decode(String.self, forKey: .meeting)
        actor = try container.decode(DecisionActor.self, forKey: .actor)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        action = try container.decode(DecisionAction.self, forKey: .action)
        question = try container.decodeIfPresent(String.self, forKey: .question)
        decided = try container.decodeIfPresent([String].self, forKey: .decided) ?? []
        settled = try container.decodeIfPresent([String].self, forKey: .settled) ?? []
        skipped = try container.decodeIfPresent([DecisionSkip].self, forKey: .skipped) ?? []
        changes = try container.decodeIfPresent([ItemChange].self, forKey: .changes) ?? []
        labels = try container.decodeIfPresent([LabelChange].self, forKey: .labels) ?? []
        revertedBy = try container.decodeIfPresent(String.self, forKey: .revertedBy)
    }

    /// Every item id this entry changed, decided or settled.
    var touched: Set<String> {
        Set(decided).union(settled).union(changes.map(\.id))
    }
}

/// What a decision did: its journal entry (nil when it changed nothing) and each named item it left.
struct DecisionResult: Decodable, Equatable {
    let entry: JournalEntry?
    let skipped: [DecisionSkip]
    let warnings: [String]?
}

/// What a planned decision reaches beyond the items it names (`DecisionReach`): look-alikes it settles, the lines a
/// spelling changes, the dictionary entries it teaches.
struct DecisionReach: Decodable, Equatable {
    struct Item: Decodable, Equatable, Hashable { let id: String; let match: String }
    struct Dictionary: Decodable, Equatable, Hashable {
        let project: String?
        let heard: String
        let fixed: String
        let seenBefore: Int
        let teaches: Bool
    }

    let items: [Item]
    let lines: Int?
    let dictionary: [Dictionary]

    /// Nothing beyond the named items: no sheet to show.
    var isEmpty: Bool { items.isEmpty && (lines ?? 0) <= 1 && dictionary.allSatisfy { !$0.teaches } }
}

/// A refusal's `data` for `already-decided`: the items and the entry that decided them since the caller saw them.
struct AlreadyDecided: Decodable, Equatable {
    let code: String
    let items: [String]
    let entry: JournalEntry?
}

extension MeetingsAPI {
    /// The members `decision.plan` and `decision.apply` share.
    struct DecisionParams: Codable, Equatable {
        var meeting: String
        var action: DecisionAction
        var reason: String?
        /// `decision.apply` only: `refuse` answers `already-decided` for an item someone decided since the caller saw
        /// it (the window), `skip` (the default) skips it.
        var onDecided: String?
    }

    /// `decision.plan`: what `decision.apply` would do now and reach, without saving anything.
    enum DecisionPlan: MeetingsServiceMethod {
        static let name = "decision.plan"
        typealias Params = DecisionParams

        struct Result: Decodable, Equatable {
            let entry: JournalEntry?
            let skipped: [DecisionSkip]
            let reach: DecisionReach
        }
    }

    /// `decision.apply`: one decision through the journal, by the actor the connection's hello names.
    enum DecisionApply: MeetingsServiceMethod {
        static let name = "decision.apply"
        typealias Params = DecisionParams
        typealias Result = DecisionResult
    }

    /// `decision.revert`: the Undo of one entry, or only some of its items.
    enum DecisionRevert: MeetingsServiceMethod {
        static let name = "decision.revert"

        struct Params: Codable, Equatable {
            var meeting: String
            var token: String
            var items: [String]?
            var reason: String?
        }

        typealias Result = DecisionResult
    }

    /// `journal.read`: the meeting's journal, newest first.
    enum JournalRead: MeetingsServiceMethod {
        static let name = "journal.read"

        struct Params: Codable, Equatable {
            var meeting: String
            /// Only the entries that changed this item (an id or Q12).
            var item: String?
            var limit: Int?
        }

        struct Result: Decodable, Equatable {
            let meeting: String
            let entries: [JournalEntry]
        }
    }

    /// `meeting.rows`: the review rows, in the order `listen` asks.
    enum MeetingRows: MeetingsServiceMethod {
        static let name = "meeting.rows"

        struct Params: Codable, Equatable {
            var meeting: String
            /// `show` keeps the open questions under the priority line; nil or `hide` counts them.
            var lowPriority: String?
        }

        typealias Result = ReviewRows
    }

    /// `comment.stage`: a comment for the listening agent, kept until it is sent or unstaged.
    enum CommentStage: MeetingsServiceMethod {
        static let name = "comment.stage"

        struct Params: Codable, Equatable {
            var meeting: String
            var target: MomentTarget
            var text: String
            var quote: String?
        }

        typealias Result = MeetingComment
    }

    /// `comment.list`: the staged and sent comments, and who listens now.
    enum CommentList: MeetingsServiceMethod {
        static let name = "comment.list"

        struct Params: Codable, Equatable { var meeting: String }

        struct Result: Decodable, Equatable {
            let meeting: String
            let comments: [MeetingComment]
            let listeners: [CommentListener]
        }
    }

    /// `comment.unstage`: a staged comment taken back (`already-sent` for a sent one).
    enum CommentUnstage: MeetingsServiceMethod {
        static let name = "comment.unstage"

        struct Params: Codable, Equatable {
            var meeting: String
            var id: String
        }

        typealias Result = MeetingComment
    }

    /// `comment.send`: the staged comments (or only `ids`) to the listening agent; it cannot be taken back.
    enum CommentSend: MeetingsServiceMethod {
        static let name = "comment.send"

        struct Params: Codable, Equatable {
            var meeting: String
            var ids: [String]?
            var reason: String?
        }

        struct Result: Decodable, Equatable {
            let sent: [MeetingComment]
            let listeners: [CommentListener]
            let entry: JournalEntry?
        }
    }

    // MARK: Events

    /// `decision.applied`: a decision through the service, with its entry (sent instead of `meeting.changed`).
    struct DecisionApplied: Decodable, Equatable {
        static let name = "decision.applied"
        let meeting: String
        let entry: JournalEntry
    }

    /// `decision.reverted`: an Undo through the service; `token` is the entry it undid.
    struct DecisionReverted: Decodable, Equatable {
        static let name = "decision.reverted"
        let meeting: String
        let token: String
        let entry: JournalEntry
    }

    /// `comment.sent`: comments went to the listening agent (`listeners` empty: nobody listened).
    struct CommentSent: Decodable, Equatable {
        static let name = "comment.sent"
        let meeting: String
        let token: String
        let comments: [MeetingComment]
        let listeners: [CommentListener]
    }
}

// MARK: - Review rows (`reviewRowSchema`)

/// A time as a row shows it: the second on the transcript clock and the text the terminal prints for it ("05:09").
struct ClockTime: Codable, Equatable, Hashable {
    let sec: Double
    let text: String
}

/// A piece of a row's text: plain words, or words that open something (a Moment, a commit, a work item, a document,
/// a URL).
struct TextPiece: Decodable, Equatable, Hashable {
    struct Document: Decodable, Equatable, Hashable { let path: String; let line: Int? }

    let text: String
    let target: MomentTarget?
    let commit: String?
    let workItem: String?
    let document: Document?
    let url: String?

    init(text: String, target: MomentTarget? = nil, commit: String? = nil, workItem: String? = nil,
         document: Document? = nil, url: String? = nil) {
        self.text = text
        self.target = target
        self.commit = commit
        self.workItem = workItem
        self.document = document
        self.url = url
    }
}

/// One part of a row's question, so it reads as points (R12, R17).
enum RowPart: Decodable, Equatable, Hashable {
    struct Heard: Decodable, Equatable, Hashable {
        let before: String?
        let lead: String
        let heard: String
        let rest: String
        let after: String?
    }

    /// Who speaks.
    case who(String)
    /// What was said, with the heard words apart for a word question.
    case said(text: String, speaker: String?, context: Heard?)
    /// When, with the Moment it plays.
    case when(from: ClockTime, to: ClockTime?, target: MomentTarget)
    /// What the question asks, as pieces (times in it play).
    case asks([TextPiece])
    /// What its answer settles, with the item ids (G12).
    case settles(text: String, items: [String])
    /// Why the engine or an agent suggested it.
    case reason([TextPiece])
    /// A part a newer service added.
    case other(kind: String)

    private enum CodingKeys: String, CodingKey { case kind, text, speaker, context, from, to, target, pieces, items }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "who": self = .who(try container.decode(String.self, forKey: .text))
        case "said":
            self = .said(text: try container.decode(String.self, forKey: .text),
                         speaker: try container.decodeIfPresent(String.self, forKey: .speaker),
                         context: try container.decodeIfPresent(Heard.self, forKey: .context))
        case "when":
            self = .when(from: try container.decode(ClockTime.self, forKey: .from),
                         to: try container.decodeIfPresent(ClockTime.self, forKey: .to),
                         target: try container.decode(MomentTarget.self, forKey: .target))
        case "asks": self = .asks(try container.decode([TextPiece].self, forKey: .pieces))
        case "settles":
            self = .settles(text: try container.decode(String.self, forKey: .text),
                            items: try container.decode([String].self, forKey: .items))
        case "reason": self = .reason(try container.decode([TextPiece].self, forKey: .pieces))
        default: self = .other(kind: kind)
        }
    }
}

/// The decision a choice makes on its row's item, as `decision.apply` takes it without the item reference.
struct ChoiceAction: Codable, Equatable, Hashable {
    /// confirm, reject, respell, answer, split, skip.
    let kind: String
    var speaker: String?
    var text: String?
    var answer: String?

    init(kind: String, speaker: String? = nil, text: String? = nil, answer: String? = nil) {
        self.kind = kind
        self.speaker = speaker
        self.text = text
        self.answer = answer
    }

    /// The whole decision on `row`'s item.
    func decision(on row: ReviewRow) -> DecisionAction {
        switch kind {
        case "confirm": return .confirm([row.id], speaker: speaker)
        case "reject": return .reject([row.id])
        case "respell": return .respell(row.id, to: text ?? "")
        case "answer": return .answer(row.id, answer ?? "")
        case "split": return .split(row.id)
        case "skip": return .skip(row.id)
        default: return DecisionAction(kind: kind)
        }
    }
}

/// One answer choice of a row (G1, G2), with the engine's confidence where it has one (R49).
struct RowChoice: Decodable, Equatable, Hashable, Identifiable {
    let value: String
    let label: String
    /// earlier, suggested, presumed, candidate, heard, none, split, skip.
    let role: String
    let action: ChoiceAction
    /// 0 to 1; nil where the engine has none.
    let confidence: Double?
    let hint: String?

    var id: String { "\(role):\(value)" }
}

/// Where a row's evidence comes from (G-SRC-1, G19).
enum RowSource: Decodable, Equatable, Hashable {
    case line(at: ClockTime, line: Int?, text: String?)
    case document(path: String, line: Int?)
    case commit(sha: String)
    case workItem(id: String)
    case url(String)
    case other(kind: String)

    private enum CodingKeys: String, CodingKey { case kind, at, line, text, path, sha, id, url }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "line":
            self = .line(at: try container.decode(ClockTime.self, forKey: .at),
                         line: try container.decodeIfPresent(Int.self, forKey: .line),
                         text: try container.decodeIfPresent(String.self, forKey: .text))
        case "document":
            self = .document(path: try container.decode(String.self, forKey: .path),
                             line: try container.decodeIfPresent(Int.self, forKey: .line))
        case "commit": self = .commit(sha: try container.decode(String.self, forKey: .sha))
        case "workItem": self = .workItem(id: try container.decode(String.self, forKey: .id))
        case "url": self = .url(try container.decode(String.self, forKey: .url))
        default: self = .other(kind: kind)
        }
    }
}

/// One review row (`reviewRowSchema`): what the window shows of one item, computed by the engine.
struct ReviewRow: Decodable, Equatable, Identifiable {
    /// The last decision on the item (R35).
    struct Decision: Decodable, Equatable, Hashable {
        let token: String
        let actor: DecisionActor
        /// The actor in words: "you", "an agent (Claude Code, session 3f98b772)", "rule E2".
        let by: String
        let action: String
        let reason: String?
        let question: String?
        let at: String?
    }

    let id: String
    /// `Q12` for a question (the label `listen` shows), else the item id.
    let label: String
    let kind: String
    var status: String
    let confidence: Double?
    let priority: Double?
    /// The one-line text `items` prints.
    let what: String
    let parts: [RowPart]
    let choices: [RowChoice]
    /// What the edit opens: spelling, person, answer or none.
    let edit: String
    /// What the item waits for: speaker, proposed or listen.
    let needs: String?
    let sources: [RowSource]
    /// What the row's play button plays.
    let target: MomentTarget
    let decision: Decision?

    var isOpen: Bool { status == "suggested" }
    var isQuestion: Bool { kind == "question" }
}

/// `meeting.rows`'s answer.
struct ReviewRows: Decodable, Equatable {
    struct Hidden: Decodable, Equatable { let lowPriority: Int; let minPriority: Double }

    let meeting: String
    var rows: [ReviewRow]
    let hidden: Hidden
}

// MARK: - Comments (`meetingCommentSchema`)

/// A comment for the listening agent: staged (it can still be unstaged) or sent with its journal entry's token.
struct MeetingComment: Decodable, Equatable, Identifiable {
    let id: String
    let at: String
    let target: MomentTarget
    let text: String
    let quote: String?
    let actor: DecisionActor
    /// staged or sent.
    let state: String
    let sentAt: String?
    let token: String?
}

/// A `listen --subscribe-answers --with-comments` process: who a send reaches.
struct CommentListener: Decodable, Equatable, Hashable {
    let pid: Int
    let at: String
    let actor: DecisionActor
}
