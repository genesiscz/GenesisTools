import AppKit
import Foundation

/// One changed file as every diff renderer sees it. Both sides carry full contents (not a patch),
/// so a renderer can expand the "N unmodified lines" bands; `nil` means the side does not exist.
struct DiffFile: Codable, Identifiable, Hashable {
    enum Status: String, Codable {
        case added, modified, deleted, renamed
    }

    var id: String
    var path: String
    var oldPath: String?
    var status: Status
    var additions: Int
    var deletions: Int
    var oldContents: String?
    var newContents: String?
    /// Binary or too large to show; renderers show a placeholder instead of lines.
    var skipped: String?

    var name: String {
        (path as NSString).lastPathComponent
    }

    var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir
    }
}

struct DiffViewOptions: Codable, Equatable {
    enum Style: String, Codable {
        case split, unified
    }

    var diffStyle: Style = .split
    var wrap = false
    var fontSize: Double = 13

    /// The layout picked last in any review (its header button, the View menu): every new review window
    /// and hub review opens with it, after a relaunch too.
    static let styleKey = "review.diffStyle"

    static func remembered(in store: UserDefaults = HubDefaults.store) -> DiffViewOptions {
        var options = DiffViewOptions()
        if let saved = store.string(forKey: styleKey).flatMap(Style.init(rawValue:)) {
            options.diffStyle = saved
        }
        return options
    }

    static func remember(_ style: Style, in store: UserDefaults = HubDefaults.store) {
        store.set(style.rawValue, forKey: styleKey)
    }
}

enum DiffSide: String, Codable {
    case additions, deletions
}

struct RenderedMeta: Encodable, Equatable {
    var verdict: String
    var proof: String?
    var confidence: Int?
    var reasoning: String?
    /// For a reviewer's thread on your own PR: the change the agent proposes, as markdown with code.
    var fix: String?
}

/// What a renderer shows for one comment. The store (ReviewComments.swift) owns the full record;
/// `kind` "draft" is an agent's proposed review comment (ReviewProposal.swift) with its `meta`.
struct RenderedComment: Encodable, Equatable {
    var id: String
    var fileId: String
    var side: DiffSide
    var startLine: Int
    var endLine: Int
    var body: String
    var author: String
    var when: String
    var state: String
    var remote: Bool
    var kind = "local"
    var severity: String?
    var meta: RenderedMeta?
    /// A PR thread's suggested reply (the agent's, or Martin's rewording) and where it went.
    var reply: String?
    var replyStatus: String?
    /// The live thread on the PR (`tools hub pr threads`): every note, and which buttons the card gets.
    var live: RenderedLiveThread?
    /// A local comment: the PR thread it answers (an id or an id prefix); `ReviewThreadReplies.attach`
    /// moves such a comment into that thread's card.
    var thread: String?
    /// A local comment a session's pane got: that session's name, and the time ("19:20").
    var deliveredTo: String?
    var sentAt: String?
    /// A thread card: my local reply to it, shown under the notes in place of the suggested reply.
    var localReply: RenderedLocalReply?
}

/// My local comment that answers a PR thread, as its thread card draws it (the "You" block).
struct RenderedLocalReply: Encodable, Equatable {
    var id: String
    var body: String
    var when: String
    /// `local`, `queued`, `sent`, `draft`, `posted` (`ReviewComment.State`).
    var state: String
    var deliveredTo: String?
    var sentAt: String?
}

/// One card per thread: a local comment that answers a PR thread leaves its own card and sits inside
/// that thread's card, under the notes, where the suggested reply was (the suggestion is mine now).
/// Its own card sat on the comment's last line, which the diff may not show (a 3-line thread on a
/// 1-line hunk), so after an edit it seemed to vanish; inside the thread card it shows wherever that does.
enum ReviewThreadReplies {
    static func attach(_ comments: [RenderedComment]) -> [RenderedComment] {
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
struct RenderedLiveThread: Encodable, Equatable {
    struct Note: Encodable, Equatable {
        var id: String
        var author: String
        var username: String
        var when: String
        var at: String
        var body: String
        /// My pending review comment: the card offers Edit and Delete on it.
        var isDraft: Bool
        var edited: Bool
        /// The author's profile on the host (ForgeWeb), when the host is GitHub or GitLab.
        var authorUrl: String?
        /// The comment on the host; the time links there when set.
        var url: String?
        /// The author's picture on the host; the card keeps the initial when it does not load.
        var avatarUrl: String? = nil
        /// `body` with commit ids and PR/MR references as links (`PRRefLinker`): what the card shows.
        /// `body` stays the note's own text, the one Edit opens. Nil when the two are the same.
        var display: String? = nil
    }

    var notes: [Note]
    var resolved: Bool
    var resolvable: Bool
    var canReply: Bool
}

/// A button on a live PR thread card. The page only reports it; Swift confirms and runs `tools`.
struct ThreadActionInput: Equatable {
    enum Action: String {
        case reply, resolve, unresolve
        case noteUpdate = "note.update"
        case noteDelete = "note.delete"
    }

    /// The card id: `live:<threadId>` or a proposal's `thread:<threadId>`.
    var id: String
    var action: Action
    var draft = false
    var noteID: String?
    var body: String?

    init(id: String, action: Action, draft: Bool = false, noteID: String? = nil, body: String? = nil) {
        self.id = id
        self.action = action
        self.draft = draft
        self.noteID = noteID
        self.body = body
    }

    /// The page's `thread.action` message, as `renderLiveThread` posts it; nil for anything else.
    init?(message: [String: Any]) {
        guard message["type"] as? String == "thread.action", let id = message["id"] as? String,
              let action = Action(rawValue: message["action"] as? String ?? "")
        else { return nil }
        self.init(id: id, action: action, draft: message["draft"] as? Bool ?? false,
                  noteID: message["noteId"] as? String, body: message["body"] as? String)
    }

    enum Confirmation { case post, deleteDraft }

    /// What Swift must ask before it runs this: a published reply is seen by everyone at once, and a
    /// deleted draft cannot come back. A draft reply, an edit and a resolve run without a question.
    var confirmation: Confirmation? {
        switch action {
        case .reply: return draft ? nil : .post
        case .noteDelete: return .deleteDraft
        case .resolve, .unresolve, .noteUpdate: return nil
        }
    }

    var threadID: String? {
        for prefix in ["live:", "thread:"] where id.hasPrefix(prefix) {
            return String(id.dropFirst(prefix.count))
        }
        return nil
    }
}

/// Whether one card's send (For agent, Draft on PR, Post on PR, Promote) may start. The page drops a
/// card's send buttons once it went out, but a double click posts twice before the page redraws, and
/// Swift ran both: two drafts on the PR, or two agent comments. Swift checks the states the page
/// checks (main.ts `renderDraft`, `renderReply`, `renderComment`), plus a send still on its way.
enum SuggestionSendGate {
    /// `kind` is the card's kind ("draft", "thread", "local"); `state` is what the page reads: a
    /// draft's status, a thread reply's `replyStatus` (nil until sent), a local comment's state.
    static func refusal(kind: String, state: String?, toPR: Bool, inFlight: Bool, busy: String?) -> String? {
        if inFlight {
            return "This suggestion is already on its way."
        }
        if toPR, let busy {
            return "\(busy) Wait until it finishes, then send again."
        }
        switch kind {
        case "draft" where ["sent", "drafted", "posted"].contains(state ?? ""):
            return "This suggestion was already sent (\(state ?? ""))."
        case "thread" where state != nil:
            return "This reply was already sent (\(state ?? ""))."
        case "local" where state == "posted":
            return "This comment is already posted on the PR."
        default:
            return nil
        }
    }
}

/// A comment the user wrote in the renderer; `editingID` set means an edit of an existing one.
struct CommentInput: Equatable {
    var editingID: String?
    var fileID: String
    var side: DiffSide
    var startLine: Int
    var endLine: Int
    var body: String
}

enum DiffRendererEvent: Equatable {
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
    init?(pageMessage body: [String: Any]) {
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
enum DiffLineMap {
    /// Above this many lines a side, the line diff is not worth its cost for one click.
    static let maxLines = 20_000

    /// The new-side line for this old-side line (1-based): a kept line maps to its new place, a removed
    /// line to the line now where it was. Without both texts, or past `maxLines`, the line stays as is.
    static func newLine(forOld line: Int, old: String?, new: String?) -> Int {
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
protocol DiffRenderer: AnyObject {
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
