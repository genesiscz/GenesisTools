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
}

enum DiffSide: String, Codable {
    case additions, deletions
}

struct RenderedMeta: Encodable, Equatable {
    var verdict: String
    var proof: String?
    var confidence: Int?
    var reasoning: String?
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
}

/// A comment the user wrote in the renderer; `editingID` set means an edit of an existing one.
struct CommentInput {
    var editingID: String?
    var fileID: String
    var side: DiffSide
    var startLine: Int
    var endLine: Int
    var body: String
}

enum DiffRendererEvent {
    case ready
    case rendered(count: Int)
    case failed(String)
    case commentSubmitted(CommentInput)
    case commentDeleted(id: String)
    case commentAction(id: String, action: String)
    /// ⌘-click on a diff line: open that file at that line in the editor.
    case openLine(fileID: String, line: Int, side: DiffSide)
}

/// The swappable engine. The window owns data and chrome; a renderer only draws `DiffFile`s.
/// Today: PierreWebDiffRenderer (WKWebView + @pierre/diffs). Planned: a native NSTableView +
/// Core Text renderer behind the same protocol.
protocol DiffRenderer: AnyObject {
    var view: NSView { get }
    var onEvent: ((DiffRendererEvent) -> Void)? { get set }
    func show(_ files: [DiffFile])
    func apply(_ options: DiffViewOptions)
    func reveal(fileID: String)
    func showComments(_ comments: [RenderedComment])
}
