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
    struct Finding: Codable, Equatable, Hashable {
        var kind: String
        var from: Double?
        var to: Double?
        var at: Double?
        var question: String?
        var choices: [String]?
        var decides: [String]?
        var about: String?
        var heard: String?
        var proposed: String?
        var scope: String?
        var confidence: Double?
        var reason: String?
    }
    var findings: [Finding]? = nil
    var force: Bool? = nil
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
    /// rephrase: the wording seen when this draft opened.
    var expectedText: String?
    /// A term's chosen source lines and independent dictionary teaching choice.
    var reach: SpellingReach?
    struct SpellingReach: Codable, Equatable, Hashable {
        struct Line: Codable, Equatable, Hashable { let atSec: Double; let line: Int? }
        var lines: [Line]?
        var dictionary: Bool?
    }
    /// answer, skip, split: the question; answer: the answer and its comment.
    var question: String?
    var answer: String?
    var comment: String?
    struct VoiceSegment: Codable, Equatable, Hashable { var fromWord: Int; var speaker: String }
    var segments: [VoiceSegment]?
    /// answer: "leave" keeps the questions that look alike open ("Only this question"); nil settles them.
    var lookAlikes: String?
    /// answer: the targets and look-alikes struck in the "This also affects" sheet; they stay as they were and leave
    /// the decision, so its Undo never touches them.
    var except: [String]?
    /// answer: the token of the question's earlier answer this one replaces (a changed answer, one Undo).
    var replaces: String?
    /// rename: a diarization label and its name for this meeting.
    var label: String?
    var name: String?
    /// set: the meeting's project, title, labels to add and to remove.
    var project: String?
    var title: String?
    var labels: [String]?
    var unlabel: [String]?
    var seats: MeetingSeats?
    /// revert: the entry it undoes.
    var token: String?
    /// assign (b-people): the person a stretch or lines are given to, their address, and what is given.
    var person: String?
    var email: String?
    var stretches: [Stretch]?
    var lines: [LinePoint]?

    /// A stretch of one label an `assign` gives to a person.
    struct Stretch: Codable, Equatable, Hashable {
        var label: String?
        var fromSec: Double
        var toSec: Double
    }

    init(kind: String) { self.kind = kind }

    static func assign(_ person: String, email: String? = nil, stretches: [Stretch]? = nil, lines: [LinePoint]? = nil) -> DecisionAction {
        var action = DecisionAction(kind: "assign")
        action.person = person
        action.email = email
        action.stretches = stretches
        action.lines = lines
        return action
    }

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

    static func rephrase(_ question: String, text: String, was expectedText: String?) -> DecisionAction {
        var action = DecisionAction(kind: "rephrase")
        action.question = question
        action.text = text
        action.expectedText = expectedText
        return action
    }

    static func answer(_ question: String, _ answer: String, comment: String? = nil, segments: [VoiceSegment]? = nil) -> DecisionAction {
        var action = DecisionAction(kind: "answer")
        action.question = question
        action.answer = answer
        action.comment = comment
        action.segments = segments
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

/// A journaled assignment keeps the exact before/after speaker span, including an Undo that removes it.
struct AssignmentChange: Decodable, Equatable {
    struct Value: Decodable, Equatable {
        let id: String
        let label: String
        let fromSec: Double
        let toSec: Double
        let person: String
        let email: String?
        let at: String
    }
    let id: String
    let before: Value?
    let after: Value?
}

struct MeetingFieldChange: Decodable, Equatable {
    let field: String
    let before: JSONValue?
    let after: JSONValue?
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
    let assignments: [AssignmentChange]
    let fields: [MeetingFieldChange]
    /// `journal.read` only: the later entry that gave back every item this one decided.
    let revertedBy: String?

    var id: String { token }
    var canUndo: Bool { revertedBy == nil && !["comment", "revert", "unsupported"].contains(action.kind) }

    enum CodingKeys: String, CodingKey {
        case token, at, meeting, actor, reason, action, question, decided, settled, skipped, changes, labels, assignments, fields, revertedBy
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
        assignments = try container.decodeIfPresent([AssignmentChange].self, forKey: .assignments) ?? []
        fields = try container.decodeIfPresent([MeetingFieldChange].self, forKey: .fields) ?? []
        revertedBy = try container.decodeIfPresent(String.self, forKey: .revertedBy)
    }

    var changesTranscript: Bool {
        !labels.isEmpty || !changes.isEmpty || !assignments.isEmpty || action.kind == "assign"
            || fields.contains { $0.field == "project" }
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
    var rows: ReviewRowsPatch? = nil
}

/// What a planned decision reaches beyond the items it names (`DecisionReach`): look-alikes it settles, the lines a
/// spelling changes, the dictionary entries it teaches.
struct DecisionReach: Decodable, Equatable {
    /// One reached item (`ReachItem`, decision-journal.ts) with the evidence it is judged by.
    struct Item: Decodable, Equatable, Identifiable {
        /// `sets`: a target of the question outside the asked span; `lookAlike`: settled the same way; `same`: the
        /// same question over the same span, closed with it and never asked again.
        enum Role: String, Decodable { case sets, lookAlike = "look-alike", same }

        let id: String
        let match: String
        let role: Role
        /// What a person sees the item as before and after: a speaker, a spelling, an answer.
        let before: String?
        let after: String?
        /// Its own review row: its quote of its own speaker, its time and its play target.
        let row: ReviewRow?
        /// The answer this one replaces left it out: shown struck at first.
        let struck: Bool

        init(id: String, match: String = "same", role: Role, before: String? = nil, after: String? = nil, row: ReviewRow? = nil, struck: Bool = false) {
            self.id = id
            self.match = match
            self.role = role
            self.before = before
            self.after = after
            self.row = row
            self.struck = struck
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            match = try container.decodeIfPresent(String.self, forKey: .match) ?? "same"
            // An engine older than the roles listed only look-alikes.
            role = (try? container.decodeIfPresent(Role.self, forKey: .role)) ?? .lookAlike
            before = try container.decodeIfPresent(String.self, forKey: .before)
            after = try container.decodeIfPresent(String.self, forKey: .after)
            row = try? container.decodeIfPresent(ReviewRow.self, forKey: .row)
            struck = try container.decodeIfPresent(Bool.self, forKey: .struck) ?? false
        }

        private enum CodingKeys: String, CodingKey { case id, match, role, before, after, row, struck }
    }
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
    var spelling: Spelling? = nil
    struct Spelling: Decodable, Equatable {
        struct Occurrence: Decodable, Equatable, Identifiable {
            let line: Int
            let atSec: Double
            let speaker: String
            let text: String
            let selected: Bool
            let primary: Bool
            var id: Int { line }
        }
        let occurrences: [Occurrence]
        let dictionary: Bool
    }

    /// The items a person judges in the sheet; `same` ones are the asked question itself and are never asked again.
    var judged: [Item] { items.filter { $0.role != .same } }

    /// Nothing beyond the named items: no sheet to show. The same question over the same span is not a reach.
    var isEmpty: Bool { judged.isEmpty && (lines ?? 0) <= 1 && dictionary.allSatisfy { !$0.teaches } && spelling == nil }
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
        var lowPriority: String? = nil
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

    enum CommentRead: MeetingsServiceMethod {
        static let name = "comment.read"
        typealias Params = CommentUnstage.Params
        typealias Result = MeetingComment
    }

    enum CommentWithdraw: MeetingsServiceMethod {
        static let name = "comment.withdraw"
        typealias Params = CommentUnstage.Params
        typealias Result = MeetingComment
    }

    /// `comment.send`: the staged comments (or only `ids`) to the listening agent; it cannot be taken back.
    enum CommentSend: MeetingsServiceMethod {
        static let name = "comment.send"

        struct Params: Codable, Equatable {
            var meeting: String
            var ids: [String]?
            var reason: String?
            var requireListener: Bool? = nil
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

    struct CommentChanged: Decodable, Equatable {
        static let name = "comment.changed"
        let meeting: String
        let comment: MeetingComment?
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
    var group: String? = nil
    var reach: Double? = nil
    var comment: String? = nil
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
    var decision: Decision?
    /// What a decided row was decided as: a question's answer, a word's spelling, a range's speaker.
    var answer: String? = nil

    var isOpen: Bool { status == "suggested" }
    var isQuestion: Bool { kind == "question" }

    /// What a decided item was decided as (`decidedAs` in src/meetings/lib/review-rows.ts): a confirmed question's
    /// answer, a confirmed word's spelling, a confirmed range's speaker; nothing for an open or a rejected item.
    static func decidedAs(_ item: MeetingItem) -> String? {
        guard item.status == "confirmed" else { return nil }
        switch item.kind {
        case "question": return item.answer
        case "term": return item.proposed
        case "speaker-range": return item.speaker
        default: return nil
        }
    }
}

extension ReviewRow.Decision {
    /// The decision as `meeting.rows` names it, from the journal entry that made it (`reviewRow` in review-rows.ts).
    init(_ entry: JournalEntry) {
        self.init(token: entry.token, actor: entry.actor, by: MeetingsWords.actor(entry.actor), action: entry.action.kind,
                  reason: entry.reason, question: entry.question, at: entry.at)
    }
}

/// `meeting.rows`'s answer.
struct ReviewRows: Decodable, Equatable {
    struct Hidden: Decodable, Equatable { let lowPriority: Int; let minPriority: Double }

    let meeting: String
    var rows: [ReviewRow]
    let hidden: Hidden
}

/// A decision's changed rows. Before values protect rows that a later decision changed while this reply travelled.
struct ReviewRowsPatch: Decodable, Equatable {
    struct Change: Decodable, Equatable {
        let id: String
        let before: ReviewRow?
        let after: ReviewRow?
    }
    struct Hidden: Decodable, Equatable { let before: ReviewRows.Hidden; let after: ReviewRows.Hidden }
    struct Fields: Decodable, Equatable {
        struct Value: Decodable, Equatable {
            let title: String
            let project: String?
            let labels: [String]
            let speakerLabels: [String: String]
        }
        let before: Value
        let after: Value
    }
    let meeting: String
    let changes: [Change]
    let order: [String]
    let hidden: Hidden
    let fields: Fields

    func applying(to current: ReviewRows, token: String, latest: [String: String]) -> ReviewRows {
        guard current.meeting == meeting else { return current }
        var rows = current.rows
        var conflicted = false
        for change in changes {
            if let last = latest[change.id], last != token, last != change.before?.decision?.token {
                conflicted = true
                continue
            }
            let index = rows.firstIndex { $0.id == change.id }
            let present = index.map { rows[$0] }
            var optimistic = change.before
            if let status = change.after?.status { optimistic?.status = status }
            // `markRows` also sets the answer and this entry's decision, so a row the event marked is still this read.
            var marked = optimistic
            marked?.answer = change.after?.answer
            let unmarked = present.map { row -> ReviewRow in
                var row = row
                if row.decision?.token == token { row.decision = change.before?.decision }
                return row
            }
            guard present == change.before || present == change.after || present == optimistic || unmarked == marked else {
                conflicted = true
                continue
            }
            if let after = change.after {
                if let index { rows[index] = after } else { rows.append(after) }
            } else if let index {
                rows.remove(at: index)
            }
        }
        if !conflicted {
            let positions = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($0.element, $0.offset) })
            rows = rows.enumerated().sorted {
                let a = positions[$0.element.id] ?? Int.max, b = positions[$1.element.id] ?? Int.max
                return a == b ? $0.offset < $1.offset : a < b
            }.map(\.element)
        }
        return ReviewRows(meeting: current.meeting, rows: rows,
                          hidden: !conflicted && current.hidden == hidden.before ? hidden.after : current.hidden)
    }
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
    /// staged or sent; a sent comment can carry its receipt or withdrawal time.
    let state: String
    let sentAt: String?
    let token: String?
    var readAt: String? = nil
    var readBy: DecisionActor? = nil
    var withdrawnAt: String? = nil

    var canWithdraw: Bool { state == "sent" && readAt == nil && withdrawnAt == nil }
}

/// A `listen --subscribe-answers --with-comments` process: who a send reaches.
struct CommentListener: Decodable, Equatable, Hashable {
    let pid: Int
    let at: String
    let actor: DecisionActor
}
