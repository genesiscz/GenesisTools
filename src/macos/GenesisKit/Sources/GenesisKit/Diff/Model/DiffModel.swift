import AppKit
import Foundation

/// One changed file as every diff renderer sees it. Both sides carry full contents (not a patch),
/// so a renderer can expand the "N unmodified lines" bands; `nil` means the side does not exist.
public struct DiffFile: Codable, Identifiable, Hashable {
    public enum Status: String, Codable {
        case added, modified, deleted, renamed
    }

    public var id: String
    public var path: String
    public var oldPath: String?
    public var status: Status
    public var additions: Int
    public var deletions: Int
    public var oldContents: String?
    public var newContents: String?
    /// Binary or too large to show; renderers show a placeholder instead of lines.
    public var skipped: String?

    public var name: String {
        (path as NSString).lastPathComponent
    }

    public var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir
    }

    public init(id: String, path: String, oldPath: String? = nil, status: Status, additions: Int, deletions: Int, oldContents: String? = nil, newContents: String? = nil, skipped: String? = nil) {
        self.id = id
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.additions = additions
        self.deletions = deletions
        self.oldContents = oldContents
        self.newContents = newContents
        self.skipped = skipped
    }
}

public struct DiffViewOptions: Codable, Equatable {
    public enum Style: String, Codable {
        case split, unified
    }

    public var diffStyle: Style = .split
    public var wrap = false
    public var fontSize: Double = 13

    public init(diffStyle: Style = .split, wrap: Bool = false, fontSize: Double = 13) {
        self.diffStyle = diffStyle
        self.wrap = wrap
        self.fontSize = fontSize
    }
}

public enum DiffSide: String, Codable {
    case additions, deletions
}

public struct RenderedMeta: Encodable, Equatable {
    public var verdict: String
    public var proof: String?
    public var confidence: Int?
    public var reasoning: String?
    /// For a reviewer's thread on your own PR: the change the agent proposes, as markdown with code.
    public var fix: String?

    public init(verdict: String, proof: String? = nil, confidence: Int? = nil, reasoning: String? = nil, fix: String? = nil) {
        self.verdict = verdict
        self.proof = proof
        self.confidence = confidence
        self.reasoning = reasoning
        self.fix = fix
    }
}

/// What a renderer shows for one comment. The store (ReviewComments.swift) owns the full record;
/// `kind` "draft" is an agent's proposed review comment (ReviewProposal.swift) with its `meta`.
public struct RenderedComment: Encodable, Equatable {
    public var id: String
    public var fileId: String
    public var side: DiffSide
    public var startLine: Int
    public var endLine: Int
    public var body: String
    public var author: String
    public var when: String
    public var state: String
    public var remote: Bool
    public var kind = "local"
    public var severity: String?
    public var meta: RenderedMeta?
    /// A PR thread's suggested reply (the agent's, or Martin's rewording) and where it went.
    public var reply: String?
    public var replyStatus: String?
    /// The live thread on the PR (`tools hub pr threads`): every note, and which buttons the card gets.
    public var live: RenderedLiveThread?
    /// A local comment: the PR thread it answers (an id or an id prefix); `ReviewThreadReplies.attach`
    /// moves such a comment into that thread's card.
    public var thread: String?
    /// A local comment a session's pane got: that session's name, and the time ("19:20").
    public var deliveredTo: String?
    public var sentAt: String?
    /// A thread card: my local reply to it, shown under the notes in place of the suggested reply.
    public var localReply: RenderedLocalReply?

    public init(id: String, fileId: String, side: DiffSide, startLine: Int, endLine: Int, body: String, author: String, when: String, state: String, remote: Bool, kind: String = "local", severity: String? = nil, meta: RenderedMeta? = nil, reply: String? = nil, replyStatus: String? = nil, live: RenderedLiveThread? = nil, thread: String? = nil, deliveredTo: String? = nil, sentAt: String? = nil, localReply: RenderedLocalReply? = nil) {
        self.id = id
        self.fileId = fileId
        self.side = side
        self.startLine = startLine
        self.endLine = endLine
        self.body = body
        self.author = author
        self.when = when
        self.state = state
        self.remote = remote
        self.kind = kind
        self.severity = severity
        self.meta = meta
        self.reply = reply
        self.replyStatus = replyStatus
        self.live = live
        self.thread = thread
        self.deliveredTo = deliveredTo
        self.sentAt = sentAt
        self.localReply = localReply
    }
}

/// My local comment that answers a PR thread, as its thread card draws it (the "You" block).
public struct RenderedLocalReply: Encodable, Equatable {
    public var id: String
    public var body: String
    public var when: String
    /// `local`, `queued`, `sent`, `draft`, `posted` (`ReviewComment.State`).
    public var state: String
    public var deliveredTo: String?
    public var sentAt: String?

    public init(id: String, body: String, when: String, state: String, deliveredTo: String? = nil, sentAt: String? = nil) {
        self.id = id
        self.body = body
        self.when = when
        self.state = state
        self.deliveredTo = deliveredTo
        self.sentAt = sentAt
    }
}

/// One card per thread: a local comment that answers a PR thread leaves its own card and sits inside
/// that thread's card, under the notes, where the suggested reply was (the suggestion is mine now).
/// Its own card sat on the comment's last line, which the diff may not show (a 3-line thread on a
/// 1-line hunk), so after an edit it seemed to vanish; inside the thread card it shows wherever that does.
public enum ReviewThreadReplies {
    public static func attach(_ comments: [RenderedComment]) -> [RenderedComment] {
        var replies: [String: RenderedComment] = [:]
        var cardOf: [String: String] = [:]
        for card in comments where card.kind == "thread" {
            let threadID = card.id.replacingOccurrences(of: "^(live|thread):", with: "", options: .regularExpression)
            for reply in comments where reply.kind == "local" {
                guard let ref = reply.thread, !ref.isEmpty, cardOf[reply.id] == nil, threadID.hasPrefix(ref) else { continue }
                cardOf[reply.id] = card.id
                replies[card.id] = replies[card.id] ?? reply
            }
        }
        let attached = Set(replies.values.map(\.id))
        return comments.compactMap { comment in
            if attached.contains(comment.id) {
                return nil
            }

            guard let reply = replies[comment.id] else { return comment }
            var card = comment
            card.localReply = RenderedLocalReply(id: reply.id, body: reply.body, when: reply.when, state: reply.state,
                                                 deliveredTo: reply.deliveredTo, sentAt: reply.sentAt)
            card.reply = nil
            return card
        }
    }
}

/// A PR thread as the card draws it, GitLab style: the notes in order, then Reply and Resolve.
public struct RenderedLiveThread: Encodable, Equatable {
    public struct Note: Encodable, Equatable {
        public var id: String
        public var author: String
        public var username: String
        public var when: String
        public var at: String
        public var body: String
        /// My pending review comment: the card offers Edit and Delete on it.
        public var isDraft: Bool
        public var edited: Bool
        /// The author's profile on the host (ForgeWeb), when the host is GitHub or GitLab.
        public var authorUrl: String?
        /// The comment on the host; the time links there when set.
        public var url: String?
        /// The author's picture on the host; the card keeps the initial when it does not load.
        public var avatarUrl: String? = nil
        /// `body` with commit ids and PR/MR references as links (`PRRefLinker`): what the card shows.
        /// `body` stays the note's own text, the one Edit opens. Nil when the two are the same.
        public var display: String? = nil

        public init(id: String, author: String, username: String, when: String, at: String, body: String, isDraft: Bool, edited: Bool, authorUrl: String? = nil, url: String? = nil, avatarUrl: String? = nil, display: String? = nil) {
            self.id = id
            self.author = author
            self.username = username
            self.when = when
            self.at = at
            self.body = body
            self.isDraft = isDraft
            self.edited = edited
            self.authorUrl = authorUrl
            self.url = url
            self.avatarUrl = avatarUrl
            self.display = display
        }
    }

    public var notes: [Note]
    public var resolved: Bool
    public var resolvable: Bool
    public var canReply: Bool

    public init(notes: [Note], resolved: Bool, resolvable: Bool, canReply: Bool) {
        self.notes = notes
        self.resolved = resolved
        self.resolvable = resolvable
        self.canReply = canReply
    }
}

/// A button on a live PR thread card. The page only reports it; Swift confirms and runs `tools`.
public struct ThreadActionInput: Equatable {
    public enum Action: String {
        case reply, resolve, unresolve
        case noteUpdate = "note.update"
        case noteDelete = "note.delete"
    }

    /// The card id: `live:<threadId>` or a proposal's `thread:<threadId>`.
    public var id: String
    public var action: Action
    public var draft = false
    public var noteID: String?
    public var body: String?

    public init(id: String, action: Action, draft: Bool = false, noteID: String? = nil, body: String? = nil) {
        self.id = id
        self.action = action
        self.draft = draft
        self.noteID = noteID
        self.body = body
    }

    /// The page's `thread.action` message, as `renderLiveThread` posts it; nil for anything else.
    public init?(message: [String: Any]) {
        guard message["type"] as? String == "thread.action", let id = message["id"] as? String,
              let action = Action(rawValue: message["action"] as? String ?? "")
        else { return nil }
        self.init(id: id, action: action, draft: message["draft"] as? Bool ?? false,
                  noteID: message["noteId"] as? String, body: message["body"] as? String)
    }

    public enum Confirmation { case post, deleteDraft }

    /// What Swift must ask before it runs this: a published reply is seen by everyone at once, and a
    /// deleted draft cannot come back. A draft reply, an edit and a resolve run without a question.
    public var confirmation: Confirmation? {
        switch action {
        case .reply: return draft ? nil : .post
        case .noteDelete: return .deleteDraft
        case .resolve, .unresolve, .noteUpdate: return nil
        }
    }

    public var threadID: String? {
        for prefix in ["live:", "thread:"] where id.hasPrefix(prefix) {
            return String(id.dropFirst(prefix.count))
        }
        return nil
    }
}

/// A comment the user wrote in the renderer; `editingID` set means an edit of an existing one.
public struct CommentInput: Equatable {
    public var editingID: String?
    public var fileID: String
    public var side: DiffSide
    public var startLine: Int
    public var endLine: Int
    public var body: String

    public init(editingID: String? = nil, fileID: String, side: DiffSide, startLine: Int, endLine: Int, body: String) {
        self.editingID = editingID
        self.fileID = fileID
        self.side = side
        self.startLine = startLine
        self.endLine = endLine
        self.body = body
    }
}

public enum DiffRendererEvent: Equatable {
    case ready
    case rendered(count: Int)
    case failed(String)
    case commentSubmitted(CommentInput)
    case commentDeleted(id: String)
    case commentAction(id: String, action: String)
    /// ⌘-click on a diff line: open that file at that line in the editor.
    case openLine(fileID: String, line: Int, side: DiffSide)
    /// Reply / Resolve / Edit / Delete on a live PR thread card.
    case threadAction(ThreadActionInput)
    /// A link inside a comment body (http / https only).
    case openURL(URL)
    /// The page moved to a file on its own (a find match): the file list selects it.
    case focusFile(String)
    /// A card's Fix checkbox: this PR thread is in or out of the "Fix threads" selection.
    case threadSelect(id: String, selected: Bool)
    /// A review key (j k r e x f n p s) while the diff has the keyboard and nothing is being typed.
    case key(ReviewKey)
    /// The pointer is on a file whose agent blame the page does not have yet.
    case blameNeed(fileID: String)
    /// "Open the turn" on a line's agent blame tip: the source at this index of the last `setBlame`.
    case blameOpen(index: Int)
    /// A right-click on a file's header: Swift shows the file's path menu, with Copy for any text
    /// selected on the page.
    case headerMenu(fileID: String, selection: String)

    /// A page message (web/diff-viewer/main.ts `post`) as the event it stands for. `ready`, `rendered`
    /// and `log` stay with the renderer, which owns the state they need; nil for those and for a
    /// message that lacks a field its receiver needs.
    public init?(pageMessage body: [String: Any]) {
        guard let type = body["type"] as? String else { return nil }
        let side = DiffSide(rawValue: body["side"] as? String ?? "") ?? .additions
        switch type {
        case "error":
            self = .failed(body["message"] as? String ?? "unknown page error")
        case "comment.add", "comment.edit":
            guard let fileID = body["fileId"] as? String,
                  let start = body["startLine"] as? Int,
                  let end = body["endLine"] as? Int,
                  let text = body["body"] as? String
            else { return nil }
            self = .commentSubmitted(CommentInput(
                editingID: type == "comment.edit" ? body["id"] as? String : nil,
                fileID: fileID,
                side: side,
                startLine: start,
                endLine: end,
                body: text
            ))
        case "focusFile":
            guard let fileID = body["fileId"] as? String else { return nil }
            self = .focusFile(fileID)
        case "open":
            guard let fileID = body["fileId"] as? String, let line = body["line"] as? Int else { return nil }
            self = .openLine(fileID: fileID, line: line, side: side)
        case "comment.delete":
            guard let id = body["id"] as? String else { return nil }
            self = .commentDeleted(id: id)
        case "comment.action":
            guard let id = body["id"] as? String, let action = body["action"] as? String else { return nil }
            self = .commentAction(id: id, action: action)
        case "thread.action":
            guard let input = ThreadActionInput(message: body) else { return nil }
            self = .threadAction(input)
        case "thread.select":
            guard let id = body["id"] as? String, let selected = body["selected"] as? Bool else { return nil }
            self = .threadSelect(id: id, selected: selected)
        case "key":
            guard let key = ReviewKey(rawValue: body["key"] as? String ?? "") else { return nil }
            self = .key(key)
        case "blame.need":
            guard let fileID = body["fileId"] as? String else { return nil }
            self = .blameNeed(fileID: fileID)
        case "blame.open":
            guard let index = body["index"] as? Int else { return nil }
            self = .blameOpen(index: index)
        case "header.menu":
            guard let fileID = body["fileId"] as? String else { return nil }
            self = .headerMenu(fileID: fileID, selection: body["selection"] as? String ?? "")
        case "link":
            // Only web pages leave the viewer; anything else in a comment stays text.
            guard let raw = body["url"] as? String, let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else { return nil }
            self = .openURL(url)
        default:
            return nil
        }
    }
}

/// Where a line of the diff sits in the file on disk. The page reports a click on the old side with
/// the OLD line number; the editor opens the new text, where that number points somewhere else.
public enum DiffLineMap {
    /// Above this many lines a side, the line diff is not worth its cost for one click.
    public static let maxLines = 20_000

    /// The new-side line for this old-side line (1-based): a kept line maps to its new place, a removed
    /// line to the line now where it was. Without both texts, or past `maxLines`, the line stays as is.
    public static func newLine(forOld line: Int, old: String?, new: String?) -> Int {
        guard let old, let new else { return line }
        let oldLines = old.split(separator: "\n", omittingEmptySubsequences: false)
        let newLines = new.split(separator: "\n", omittingEmptySubsequences: false)
        guard line >= 1, line <= oldLines.count, oldLines.count <= maxLines, newLines.count <= maxLines else { return line }

        var removed = Set<Int>()
        var inserted = Set<Int>()
        for change in newLines.difference(from: oldLines) {
            switch change {
            case .remove(let offset, _, _): removed.insert(offset)
            case .insert(let offset, _, _): inserted.insert(offset)
            }
        }

        // Walk both sides together: a kept line advances both, a removed one only the old side, an
        // inserted one only the new side.
        let target = line - 1
        var oldIndex = 0
        var newIndex = 0
        while oldIndex < target {
            if removed.contains(oldIndex) {
                oldIndex += 1
            } else if inserted.contains(newIndex) {
                newIndex += 1
            } else {
                oldIndex += 1
                newIndex += 1
            }
        }
        if !removed.contains(target) {
            while inserted.contains(newIndex) {
                newIndex += 1
            }
        }
        return min(newIndex + 1, max(newLines.count, 1))
    }
}

/// The swappable engine. The window owns data and chrome; a renderer only draws `DiffFile`s.
/// Today: PierreWebDiffRenderer (WKWebView + @pierre/diffs). Planned: a native NSTableView +
/// Core Text renderer behind the same protocol.
public protocol DiffRenderer: AnyObject {
    var view: NSView { get }
    var onEvent: ((DiffRendererEvent) -> Void)? { get set }
    /// Every file of the diff; the renderer lays out only what is near the viewport. An empty view
    /// shows files as they arrive; a new set over a shown one replaces it in one step, and `fresh`
    /// (a new scope) starts it at the top instead of keeping the scroll position.
    func show(_ files: [DiffFile], fresh: Bool)
    func apply(_ options: DiffViewOptions)
    func reveal(fileID: String)
    /// Find in every file of the diff (⌘F).
    func find()
    func showComments(_ comments: [RenderedComment])
    /// A thread action ended: `ok` clears the card's reply or edit box, else it stays for another try.
    func threadActionFinished(id: String, ok: Bool)
    /// The PR thread ids the cards show as picked for "Fix threads".
    func setThreadSelection(_ ids: [String])
    /// j / k: scroll to this card and mark it (nil clears the mark); `reply` opens its reply box (r).
    func focusThread(cardID: String?, reply: Bool)
    /// The page's key list (? on the page; a snapshot's `--keys`).
    func showKeys(_ show: Bool)
    /// Which agent session and turn wrote each new line; a hover on the page shows it.
    func setBlame(_ payload: AgentBlamePayload)
    /// A snapshot's `--blame`: that line's tip without a pointer.
    func showBlame(fileID: String, line: Int)
}
