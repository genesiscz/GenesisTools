// The safe delete's approval window (`--rpc {"method":"rm.approve"}`).
//
// `tools rm approve <id>`, `tools rm config set` and the other commands that need a person ask here when the rm
// setting `approval` allows Touch ID. The window shows what will happen (each item with its icon, size, git state and
// reason, a checkbox and buttons that open it), and Touch ID listens inside the window from the first frame: a touch
// on the sensor approves, no click needed (Martin, 2026-10-29). "Use password…" asks for the account password instead.
// An agent can open the window and even press its buttons, but it cannot touch the sensor or type the password, which
// the typed code and the AppleScript dialog could not promise. The reply is the decision, how it was confirmed, the
// rows still ticked, the disposal (the trash or for good), the remember choice and a deny note; the CLI does the
// deletion. A deny and a timeout reply "deny"; a failed or cancelled touch only lets the person try again. After an
// approval the window stays 4 s to say what happens and offers `tools rm restore <id>` to copy (❓ DECISION 183).

import AppKit
import Foundation
import UniformTypeIdentifiers

struct RmApproveParams: Decodable {
    var title: String
    /// One line per path or setting, as the terminal prompt shows them. The window shows them when there is no
    /// `request` (a settings change, or a CLI from before rows).
    var lines: [String]
    /// The agent and session that ran the command, when an agent ran it.
    var caller: String?
    var folder: String?
    /// The delete or root request behind the prompt, sent by a CLI that knows rows.
    var request: RmApproveRequest?
    /// The remember choices the CLI offers (`id` goes back as it is); none hides the picker.
    var remember: [RmApproveRemember]?
    /// The CLI sends `rm.item` lines on stdin after the window opened (sizes still measured, git facts), until EOF.
    /// Without it stdin is never read.
    var live: Bool?
    /// When the sensor may listen: nil or "open" as soon as the window shows; "click" only after the person clicks
    /// "Approve with Touch ID…" (an agent opened the window with `tools rm ask`, so a touch meant for another prompt
    /// must not approve).
    var arm: String?
}

struct RmApproveRequest: Decodable {
    /// nil for a run a person confirms at once (`tools rm <paths>` on a terminal).
    var id: String?
    /// "delete" or "root".
    var kind: String
    var why: String?
    var cwd: String
    var graceMinutes: Int?
    /// When the agent asked (ISO 8601).
    var askedAt: String?
    var asker: RmApproveAsker?
    var items: [RmApproveItem]
}

struct RmApproveAsker: Decodable {
    /// The display name, e.g. "Claude Code".
    var agent: String
    var session: String?
    var project: String?
    var branch: String?
    /// The session's id and provider ("claude", "codex", "grok"), for the links to its inbox and terminal.
    var sessionId: String?
    var provider: String?
}

struct RmApproveItem: Decodable {
    var path: String
    /// "file", "dir", "symlink" or "missing".
    var kind: String
    var bytes: Int64?
    var empty: Bool?
    var storedAt: String?
    var reason: String
    /// The rule that asked ("default", "git-history", "nested-repos", …); an older CLI sends none.
    var rule: String?
    var git: RmApproveGit?
    var folderStats: RmApproveFolderStats?
    /// Other pending requests naming the same path.
    var alsoIn: [String]?
    /// Its size is still measured; an `rm.item` update brings it.
    var measuring: Bool?
}

/// One row change the CLI sends after the window opened: `{"method":"rm.item","params":{"path":…,"bytes":…}}`.
struct RmApproveItemUpdate: Decodable {
    var path: String
    var bytes: Int64?
    var empty: Bool?
    var folderStats: RmApproveFolderStats?
    var git: RmApproveGit?
    var measuring: Bool?
}

/// A line of the CLI's stdin; a method this build does not know is skipped.
private struct RmApproveLine: Decodable {
    var method: String
    var params: RmApproveItemUpdate?
}

extension RmApproveParams {
    /// The params with one row changed; a path the request does not name changes nothing.
    func applying(_ update: RmApproveItemUpdate) -> RmApproveParams {
        guard var request, let index = request.items.firstIndex(where: { $0.path == update.path }) else { return self }
        var item = request.items[index]
        if let bytes = update.bytes { item.bytes = bytes }
        if let empty = update.empty { item.empty = empty }
        if let stats = update.folderStats { item.folderStats = stats }
        if let git = update.git { item.git = git }
        if let measuring = update.measuring { item.measuring = measuring }
        request.items[index] = item
        var next = self
        next.request = request
        return next
    }

    /// No more updates come: a row still measuring shows no size rather than "Measuring…" for good.
    func endingUpdates() -> RmApproveParams {
        guard var request else { return self }
        for index in request.items.indices { request.items[index].measuring = nil }
        var next = self
        next.request = request
        return next
    }

    /// The `rm.item` update in one stdin line; nil for anything else.
    static func update(fromLine line: Data) -> RmApproveItemUpdate? {
        guard let decoded = try? JSONDecoder().decode(RmApproveLine.self, from: line), decoded.method == "rm.item" else { return nil }
        return decoded.params
    }
}

struct RmApproveGit: Decodable {
    /// "untracked", "modified", "ignored", "clean" or "none".
    var state: String
    var repo: String?
    var lastCommit: String?
}

struct RmApproveFolderStats: Decodable {
    var files: Int
    var newestAt: String?
    /// The walk stopped at its cap: `files` is a floor ("2,000+ files").
    var capped: Bool?
    /// A folder of the tree could not be listed: `files` counts only what the walk read, so 0 proves nothing.
    var unreadable: Bool?
}

struct RmApproveRemember: Decodable {
    var id: String
    var title: String
}

/// The CLI waits 180 s; this side gives up a little earlier and says why.
private let rmDeadlineSeconds: Double = 170

/// How long the window stays after an approval, saying what happens and offering the restore command (the
/// "Approval requests" setting, 4 s by default).
private var rmLingerSeconds: Double { Double(ApprovalAttention.linger) }

/// Without rows, the window shows this many lines; the rest are folded into Details.
private let rmShownLines = 6

private func rmEmit(decision: String, method: String, reason: String, extra: [String: Any] = [:]) -> Never {
    logClick("rm.approve decision=\(decision) method=\(method) reason=\(reason)")
    emitResult(["decision": decision, "method": method, "reason": reason].merging(extra) { _, new in new })
}

/// What the rm window shows, built from the CLI's request. Pure apart from the Finder icons (`icons: false` skips
/// them), so tests read it.
struct RmWindowContent {
    var title: String
    var purpose: String
    var facts: [ApprovalFact]
    var details: [ApprovalFact]
    var items: [ApprovalItem]
    var footnote: String
    /// "5 items, 34 kB, 1 already gone" under the rows; nil without rows.
    var summary: String?
    /// The ways out of a delete request; empty for a root request or a prompt without rows.
    var disposals: [ApprovalChoice]
    /// Rows carry a checkbox (a delete request with rows).
    var selectable: Bool
    /// The sensor listens only after the person clicks "Approve with Touch ID…" (`arm: "click"`).
    var touchIDWaitsForClick = false

    static let trashDisposal = "trash"

    /// The purpose's last sentence when an agent opened the window itself.
    static func clickSentence(agent: String?) -> String {
        "\(agent ?? "An agent") opened this window; Touch ID listens only after you click Approve with Touch ID."
    }
    static let permanentDisposal = "permanent"

    static func build(_ params: RmApproveParams, home: String = NSHomeDirectory(), icons: Bool = true,
                      markdownApp: Bool = PathOpener.genesisMarkdownApp() != nil, now: Date = Date(), iconCache: RmIconCache? = nil) -> RmWindowContent {
        guard let request = params.request else { return lineContent(params, home: home) }

        var facts: [ApprovalFact] = []
        let why = request.why?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !why.isEmpty {
            facts.append(ApprovalFact("Reason", why))
        } else if request.asker != nil {
            facts.append(ApprovalFact("Reason", "No reason given", dimmed: true))
        }
        facts.append(ApprovalFact(askedFromLabel, VaultWindowContent.shortPath(request.cwd, home: home), help: request.cwd))
        if let asked = request.askedAt.flatMap(parseDate) {
            facts.append(ApprovalFact("Asked", "\(ago(asked, now: now)) (\(stamp(asked)))", help: request.askedAt))
        }

        // Gone items last: there is nothing to decide about them.
        let ordered = request.items.enumerated().sorted { a, b in
            (a.element.kind == "missing" ? 1 : 0, a.offset) < (b.element.kind == "missing" ? 1 : 0, b.offset)
        }.map(\.element)
        let items = ordered.map {
            item($0, cwd: request.cwd, project: request.asker?.project, home: home, icons: icons, markdownApp: markdownApp,
                 now: now, iconCache: iconCache)
        }
        let ledger = "Every decision is written to the tools rm ledger."
        let isDelete = request.kind == "delete"
        let waits = params.arm == "click"
        return RmWindowContent(
            title: params.title,
            purpose: waits ? "\(purpose(request)) \(clickSentence(agent: request.asker?.agent))" : purpose(request),
            facts: facts,
            details: [],
            items: items,
            footnote: request.id.map { "Request \($0). \(ledger)" } ?? ledger,
            summary: isDelete ? summary(request.items) : nil,
            disposals: isDelete ? disposals(graceMinutes: request.graceMinutes) : [],
            selectable: isDelete && items.count > 1,
            touchIDWaitsForClick: waits)
    }

    /// The fact that names the folder the request was made in (the asking session's folder, or the terminal's).
    static let askedFromLabel = "Asked from"

    /// "Delete 3 of 5 items asked by session shop-admin?" as rows are unticked; the CLI's title at the start. `who` is
    /// `askedBy(_:)`. Without an asker (a person's own run) the title names no one: "Delete 3 of 5 items?".
    static func title(selected: Int, total: Int, who: String?) -> String {
        let byWho = who.map { " asked by \($0)" } ?? ""
        if selected == total {
            return "Delete \(Plural.count(total, "item"))\(byWho)?"
        }
        return "Delete \(selected) of \(Plural.count(total, "item"))\(byWho)?"
    }

    /// Who asked, as the title names them: "session shop-admin", else "Codex in shop-web", else "Codex".
    static func askedBy(_ asker: RmApproveAsker) -> String {
        if let session = asker.session, !session.isEmpty { return "session \(session)" }
        if let project = asker.project, !project.isEmpty { return "\(asker.agent) in \(project)" }
        return asker.agent
    }

    /// "Claude Code in shop (develop) wants to delete these. They go to the trash, and tools rm restore brings them
    /// back for 1 hour."
    static func purpose(_ request: RmApproveRequest) -> String {
        let who: String
        if let asker = request.asker {
            let branch = asker.branch.map { " (\($0))" } ?? ""
            who = asker.project.map { "\(asker.agent) in \($0)\(branch)" } ?? asker.agent
        } else {
            who = ""
        }

        if request.kind == "root" {
            let asks = who.isEmpty ? "This folder needs your trust." : "\(who) wants you to trust this folder."
            return "\(asks) Agents may then delete anything inside it without asking."
        }

        let asks = who.isEmpty ? "No rule allows deleting these, so they need you." : "\(who) wants to delete these."
        return "\(asks) \(graceSentence(request.graceMinutes))"
    }

    static func graceSentence(_ minutes: Int?) -> String {
        guard let minutes else { return "They go to the trash, and tools rm restore brings them back until it is emptied." }
        if minutes <= 0 { return "They go to the trash, which is emptied right away." }
        return "They go to the trash, and tools rm restore brings them back for \(graceSpan(minutes))."
    }

    /// "2 hours" for a whole number of hours, else "90 minutes".
    static func graceSpan(_ minutes: Int) -> String {
        minutes % 60 == 0 ? Plural.count(minutes / 60, "hour") : Plural.count(minutes, "minute")
    }

    /// The two ways out of a delete: the trash with its grace, or for good.
    static func disposals(graceMinutes: Int?) -> [ApprovalChoice] {
        let grace: String
        if let graceMinutes, graceMinutes > 0 {
            grace = "deleted after \(graceSpan(graceMinutes)); tools rm restore brings it back until then"
        } else {
            grace = "tools rm restore brings it back until the trash is emptied"
        }
        return [
            ApprovalChoice(id: trashDisposal, title: "Move to the trash", detail: grace),
            ApprovalChoice(id: permanentDisposal, title: "Delete permanently", detail: "no way back"),
        ]
    }

    /// "5 items, 34 kB, 1 already gone"; "5 items, measuring 2 sizes" until every size is in. A size that could not
    /// be measured keeps the total from reading as complete: "2 items, at least 2 kB, 1 size unknown".
    static func summary(_ items: [RmApproveItem]) -> String {
        let gone = items.filter { $0.kind == "missing" }.count
        let present = items.filter { $0.kind != "missing" }
        let measuring = present.filter { $0.measuring == true }.count
        let unknown = present.filter { $0.measuring != true && $0.bytes == nil && $0.empty != true }.count
        let bytes = present.compactMap(\.bytes).reduce(0, +)
        var parts = [Plural.count(items.count, "item")]
        if measuring > 0 {
            parts.append("measuring \(Plural.count(measuring, "size"))")
        } else if unknown > 0 {
            if bytes > 0 { parts.append("at least \(ByteFormat.file(bytes))") }
            parts.append("\(Plural.count(unknown, "size")) unknown")
        } else if bytes > 0 {
            parts.append(ByteFormat.file(bytes))
        }
        if gone > 0 { parts.append("\(gone) already gone") }
        return parts.joined(separator: ", ")
    }

    /// "0 B", "12.4 KB", "Already gone", "Measuring…". An empty folder reads "0 B": its "empty folder" chip says the
    /// rest, so the row does not say it twice.
    static func size(_ item: RmApproveItem) -> String? {
        if item.kind == "missing" { return "Already gone" }
        if item.measuring == true { return "Measuring…" }
        if item.kind == "dir", item.empty == true { return ByteFormat.file(0) }
        guard let bytes = item.bytes else { return nil }
        if bytes == 0, item.kind == "file" { return "Empty file" }
        return ByteFormat.file(bytes)
    }

    /// "12 files, newest 2 hours ago." for a folder with stats; nothing for an empty one (its chip says so). A walk
    /// that could not list a folder says so, and its count is a floor like a capped one.
    static func folderDetail(_ stats: RmApproveFolderStats?, now: Date) -> String? {
        guard let stats else { return nil }
        let unreadable = stats.unreadable == true
        if stats.files == 0 { return unreadable ? "Some folders inside could not be read." : nil }
        let newest = stats.newestAt.flatMap(parseDate).map { ", newest \(ago($0, now: now))" } ?? ""
        let floor = stats.capped == true || unreadable
        let count = floor ? "\(stats.files.formatted(.number.locale(Locale(identifier: "en_US"))))+ files" : Plural.count(stats.files, "file")
        return "\(count)\(newest)\(unreadable ? "; some folders inside could not be read" : "")."
    }

    /// One row. `cwd` is the asking session's folder (the row's folder reads relative to it); `project` is the
    /// asker's project, which a stray copy is often named after.
    static func item(_ item: RmApproveItem, cwd: String? = nil, project: String? = nil, home: String, icons: Bool,
                     markdownApp: Bool, now: Date = Date(), iconCache: RmIconCache? = nil) -> ApprovalItem {
        let gone = item.kind == "missing"
        let location = item.storedAt ?? item.path
        let isFolder = item.kind == "dir"
        let ext = (item.path as NSString).pathExtension.lowercased()
        return ApprovalItem(
            path: item.path,
            location: location,
            name: (item.path as NSString).lastPathComponent,
            folder: folderLabel((item.path as NSString).deletingLastPathComponent, cwd: cwd, home: home),
            size: size(item),
            reason: item.reason,
            gone: gone,
            aside: item.storedAt != nil,
            isFolder: isFolder,
            opensInMarkdown: !gone && markdownApp && ["md", "markdown"].contains(ext),
            icon: icons ? (iconCache?.icon(for: location, isFolder: isFolder, gone: gone) ?? icon(for: location, isFolder: isFolder, gone: gone)) : nil,
            git: item.git.map { ApprovalGitState(state: $0.state, lastCommit: $0.lastCommit) },
            detail: isFolder && !gone ? folderDetail(item.folderStats, now: now) : nil,
            alsoIn: item.alsoIn ?? [],
            notes: notes(item, cwd: cwd, project: project),
            risk: risk(item))
    }

    /// The row's folder as the asking session sees it: "./" for an item right in `cwd`, "./Design/Admin" deeper, else
    /// the `~` path.
    static func folderLabel(_ parent: String, cwd: String?, home: String) -> String {
        if let cwd, cwd.count > 1 {
            let base = cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd
            if parent == base { return "./" }
            if parent.hasPrefix(base + "/") { return "./" + parent.dropFirst(base.count + 1) }
        }
        return VaultWindowContent.shortPath(parent, home: home)
    }

    /// The chips on the folder line: a name that repeats its folder's or the repository's, and an empty folder.
    static func notes(_ item: RmApproveItem, cwd: String?, project: String?) -> [ApprovalChip] {
        guard item.kind != "missing" else { return [] }
        var notes: [ApprovalChip] = []
        if let name = nameNote(item, cwd: cwd, project: project) { notes.append(name) }
        if emptyFolder(item) {
            notes.append(ApprovalChip("empty folder", help: "Nothing inside: deleting it loses no files.", tone: .quiet))
        }
        return notes
    }

    /// A folder known to hold nothing: the CLI says `empty`, or a walk that read the whole tree found no file. A walk
    /// that stopped at its cap (`capped`) or could not list a folder (`unreadable`) counted only the entries it read,
    /// so its 0 files proves nothing.
    static func emptyFolder(_ item: RmApproveItem) -> Bool {
        guard item.kind == "dir" else { return false }
        if item.empty == true { return true }
        guard let stats = item.folderStats else { return false }
        return stats.files == 0 && stats.capped != true && stats.unreadable != true
    }

    /// "same name as its folder" (`ReservineBack/ReservineBack`) or "same name as the repository" (a `shop-web` folder
    /// somewhere inside the shop-web project): both are often a stray copy left by a wrong `cd` or a doubled path.
    static func nameNote(_ item: RmApproveItem, cwd: String?, project: String?) -> ApprovalChip? {
        let name = (item.path as NSString).lastPathComponent
        guard !name.isEmpty else { return nil }
        func same(_ other: String?) -> Bool {
            guard let other, !other.isEmpty else { return false }
            return name.caseInsensitiveCompare(other) == .orderedSame
        }
        let why = "Often a stray copy left by a wrong cd or a doubled path. Check that it is not the one in use before you approve."
        let parent = ((item.path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        if same(parent) {
            return ApprovalChip("same name as its folder", help: "It is named like the folder it sits in. \(why)", tone: .warning)
        }

        // The repository's own folder, or one the session works inside, carries the name by right.
        let repo = item.git?.repo
        let holdsTheSession = cwd.map { $0 == item.path || $0.hasPrefix(item.path + "/") } ?? false
        guard item.path != repo, !holdsTheSession else { return nil }
        if same(project) || same(repo.map { ($0 as NSString).lastPathComponent }) {
            return ApprovalChip("same name as the repository", help: "It is named like the repository. \(why)", tone: .warning)
        }
        return nil
    }

    /// The rules whose ask always means work nothing else holds (the CLI's `UNSAVED_RULES` in src/utils/rm/rules.ts).
    private static let unsavedRules: [String: String] = [
        "git-history": "A repository's git folder: its history and every commit not pushed go with it.",
        "unsaved-clone": "A clone with work not pushed: it exists only here.",
        "git-untracked": "Holds files git does not track: they may be new work nothing else holds.",
        "nested-repos": "Holds a git repository of its own: its work may exist only here.",
    ]

    /// Grey when nothing can be lost (gone, empty, or git or a build brings it back), red when the work may exist only
    /// here (not in git, changes not committed, or a rule that means unsaved work), amber for the rest: no rule allowed
    /// it, so a person looks first.
    static func risk(_ item: RmApproveItem) -> ApprovalRisk {
        if item.kind == "missing" { return ApprovalRisk(.low, why: "Already gone: there is nothing left to lose.") }
        // A rule that found unsaved work outranks an empty-looking row: the CLI looked deeper than the row's stats.
        if let rule = item.rule, let why = unsavedRules[rule] { return ApprovalRisk(.unsaved, why: why) }
        if emptyFolder(item) { return ApprovalRisk(.low, why: "An empty folder: there is nothing inside to lose.") }
        if item.kind == "file", item.bytes == 0 { return ApprovalRisk(.low, why: "An empty file: there is nothing inside to lose.") }
        switch item.git?.state {
        case "untracked": return ApprovalRisk(.unsaved, why: "Not in git: it may be new work nothing else holds.")
        case "modified": return ApprovalRisk(.unsaved, why: "Changes not committed: git cannot bring them back.")
        case "clean": return ApprovalRisk(.low, why: "Tracked and committed: git can bring it back.")
        case "ignored": return ApprovalRisk(.low, why: "Ignored by git: build output or a cache, which a build makes again.")
        default: return ApprovalRisk(.review, why: "No rule allows deleting it: look at it before you approve.")
        }
    }

    /// The Finder icon of what is there; for a gone item, the icon of its kind.
    static func icon(for path: String, isFolder: Bool, gone: Bool) -> NSImage {
        if !gone, FileManager.default.fileExists(atPath: path) {
            return NSWorkspace.shared.icon(forFile: path)
        }

        let type = isFolder ? UTType.folder : (UTType(filenameExtension: (path as NSString).pathExtension) ?? .data)
        return NSWorkspace.shared.icon(for: type)
    }

    /// A prompt without rows: who asked, the folder, and the terminal's lines as numbered facts.
    private static func lineContent(_ params: RmApproveParams, home: String) -> RmWindowContent {
        var facts: [ApprovalFact] = []
        if let caller = params.caller, !caller.isEmpty {
            facts.append(ApprovalFact("Asked by", caller))
        }

        if let folder = params.folder, !folder.isEmpty {
            facts.append(ApprovalFact(askedFromLabel, VaultWindowContent.shortPath(folder, home: home), help: folder))
        }

        // A fact's label is its SwiftUI id and a value shows at most 3 lines, so each item is its own fact, numbered.
        let items = params.lines.enumerated().map { index, line in ApprovalFact("\(index + 1)", line, monospaced: true) }
        facts.append(contentsOf: items.prefix(rmShownLines))
        let details = Array(items.dropFirst(rmShownLines))
        if !details.isEmpty {
            facts.append(ApprovalFact("More", "\(Plural.count(details.count, "more item")) in Details"))
        }

        let waits = params.arm == "click"
        let purpose = "Nothing changes until you approve. Deleted items go to the trash and can be restored with tools rm restore during the grace period."
        return RmWindowContent(
            title: params.title,
            purpose: waits ? "\(purpose) \(clickSentence(agent: nil))" : purpose,
            facts: facts, details: details, items: [],
            footnote: "Every decision is written to the tools rm ledger.",
            summary: nil, disposals: [], selectable: false, touchIDWaitsForClick: waits)
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        f.locale = Locale(identifier: "en_US")
        return f
    }()
    private static let stampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()

    static func parseDate(_ text: String) -> Date? {
        isoWithFraction.date(from: text) ?? iso.date(from: text)
    }

    /// "3 minutes ago"; a date in the future (a clock skew) reads "just now".
    static func ago(_ date: Date, now: Date) -> String {
        if date > now.addingTimeInterval(-5) { return "just now" }
        return relative.localizedString(for: date, relativeTo: now)
    }

    static func stamp(_ date: Date) -> String {
        stampFormatter.string(from: date)
    }
}

extension RmWindowContent {
    /// The approval window for this content; `who` (`askedBy(_:)`) names the asker in the title once items are
    /// deselected.
    @MainActor
    func dialogModel(items: [ApprovalItem], rememberChoices: [ApprovalRemember], verifier: ApprovalVerifier,
                     links: [ApprovalLink], deadline: Date, who: String?) -> ApprovalDialogModel {
        let model = ApprovalDialogModel(
            title: title, purpose: purpose,
            symbol: "trash.fill", facts: facts, details: details, warning: nil,
            footnote: footnote, rememberChoices: rememberChoices, rememberNote: nil,
            allowTitle: "Use password…", deadline: deadline, identifier: "rm-approve",
            items: items, verifier: verifier, links: links, summary: summary,
            disposals: disposals, hint: "Esc denies · Space previews", selectable: selectable,
            touchIDWaitsForClick: touchIDWaitsForClick)
        // The title follows the ticked count with or without an asker; with every row on it is the CLI's own title.
        let full = title
        model.titleForSelection = { selected, total in
            selected == total ? full : RmWindowContent.title(selected: selected, total: total, who: who)
        }
        return model
    }
}

/// The Finder icons of one window's rows, read once per path: a size or git fact that arrives later rebuilds the rows
/// without asking the file system and NSWorkspace for every icon again on the main thread.
final class RmIconCache {
    private var images: [String: NSImage] = [:]
    /// How many icons were read, not served from the cache.
    private(set) var loads = 0

    func icon(for path: String, isFolder: Bool, gone: Bool) -> NSImage {
        let key = "\(gone ? "gone" : isFolder ? "folder" : "file"):\(path)"
        if let image = images[key] { return image }
        loads += 1
        let image = RmWindowContent.icon(for: path, isFolder: isFolder, gone: gone)
        images[key] = image
        return image
    }
}

@MainActor private let rmPresenter = ApprovalPanelPresenter()

/// Where the person can look before deciding: the asking session's inbox in the hub, and its terminal.
private func rmLinks(_ request: RmApproveRequest?) -> [ApprovalLink] {
    guard let asker = request?.asker, let sessionId = asker.sessionId, !sessionId.isEmpty else { return [] }
    var links = [
        ApprovalLink(title: "Open its inbox", symbol: "tray") {
            logClick("rm.approve link=inbox session=\(sessionId)")
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            open.arguments = ["-n", Bundle.main.bundlePath, "--args", "--hub", "--mode", "inbox", "--session", sessionId]
            try? open.run()
        },
    ]
    // An asker that names no provider is a Claude Code session (the field came later); a provider with no harness
    // driver has no `tools <agent> cmux focus`.
    let harness: Harness? = asker.provider == nil ? .claude : asker.provider.flatMap(Harness.init(rawValue:))
    if let harness {
        links.append(ApprovalLink(title: "Its terminal", symbol: "terminal") {
            logClick("rm.approve link=terminal session=\(sessionId)")
            // The launcher runs `tools` programs (`GenesisTools <program> [args]`), with the app's identity.
            let focus = Process()
            focus.executableURL = Bundle.main.executableURL
            focus.arguments = [harness.rawValue, "cmux", "focus", sessionId]
            try? focus.run()
        })
    }
    return links
}

/// Reads the CLI's `rm.item` lines from stdin on a thread of its own until EOF; both callbacks run on the main queue.
private func rmFollowUpdates(onUpdate: @escaping @MainActor (RmApproveItemUpdate) -> Void, onEnd: @escaping @MainActor () -> Void) {
    Thread.detachNewThread {
        let input = FileHandle.standardInput
        var pending = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            pending.append(chunk)
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = pending.subdata(in: pending.startIndex..<newline)
                pending = pending.subdata(in: pending.index(after: newline)..<pending.endIndex)
                if let update = RmApproveParams.update(fromLine: line) {
                    DispatchQueue.main.async { MainActor.assumeIsolated { onUpdate(update) } }
                }
            }
        }
        DispatchQueue.main.async { MainActor.assumeIsolated { onEnd() } }
    }
}

func approveRm(_ params: RmApproveParams) {
    let iconCache = RmIconCache()
    let content = RmWindowContent.build(params, iconCache: iconCache)
    let audit: [String: Any] = ["title": params.title, "lines": params.lines, "caller": params.caller ?? "", "folder": params.folder ?? "",
                                "request": params.request?.id ?? ""]
    func record(_ event: String, _ extra: [String: Any] = [:]) {
        GateAudit.write(gate: "rm", event: event, audit.merging(extra) { _, new in new })
    }

    DispatchQueue.main.async {
        let verifier = ApprovalVerifier(reason: "approve: \(content.title)")
        verifier.onEvent = { event in logClick("rm.approve \(event)") }
        let rememberIds = (params.remember ?? []).map(\.id)
        let rememberChoices = (params.remember ?? []).map { ApprovalRemember(seconds: nil, title: $0.title) }
        let model = content.dialogModel(
            items: content.items, rememberChoices: rememberChoices, verifier: verifier, links: rmLinks(params.request),
            deadline: Date().addingTimeInterval(rmDeadlineSeconds),
            who: params.request?.asker.map(RmWindowContent.askedBy))

        let deadline = DispatchWorkItem {
            verifier.cancel()
            record("denied", ["detail": "no answer within \(Int(rmDeadlineSeconds))s"])
            rmEmit(decision: "deny", method: "none", reason: "no answer within \(Int(rmDeadlineSeconds))s")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + rmDeadlineSeconds, execute: deadline)

        model.onDeny = {
            deadline.cancel()
            rmPresenter.close()
            let note = model.denyNote.trimmingCharacters(in: .whitespacesAndNewlines)
            record("denied", ["detail": "denied in the approval window", "note": note])
            rmEmit(decision: "deny", method: "none", reason: "denied in the approval window", extra: ["note": note])
        }

        model.onVerified = { method, _ in
            deadline.cancel()
            let selected = model.selectedItems.map(\.path)
            let disposal = model.disposal.isEmpty ? RmWindowContent.trashDisposal : model.disposal
            let remember = rememberIds.indices.contains(model.rememberIndex) ? rememberIds[model.rememberIndex] : "once"
            let extra: [String: Any] = ["selected": selected, "disposal": disposal, "remember": remember, "note": ""]
            record("allowed", ["method": method, "selected": selected.count, "disposal": disposal, "remember": remember])
            logClick("rm.approve decision=allow method=\(method) selected=\(selected.count)/\(model.items.count) disposal=\(disposal) remember=\(remember)")
            emitResultAndStay(["decision": "allow", "method": method, "reason": ""].merging(extra) { _, new in new })

            let permanent = disposal == RmWindowContent.permanentDisposal
            let restore = params.request?.id.map { "tools rm restore \($0)" }
            model.finished(ApprovalFinish(
                headline: permanent ? "Approved: deleting for good" : "Approved: moving to the trash",
                detail: permanent
                    ? "The items are gone once the drain runs."
                    : (restore.map { "\($0) brings them back while the trash keeps them." } ?? "tools rm restore brings them back while the trash keeps them."),
                copy: permanent ? nil : restore))
            rmPresenter.linger(seconds: rmLingerSeconds) { exit(0) }
        }

        let shown = content.facts + content.details + content.items.map { ApprovalFact($0.path, $0.reason) }
        record("prompted", ["shown": GateAudit.shown(title: content.title, purpose: model.purpose, facts: shown, warning: nil, onceOnly: "only once")])
        rmPresenter.present(model)

        // The sizes the CLI still measures arrive here; each one rebuilds the rows and the total under them.
        guard params.live == true else { return }
        var current = params
        @MainActor func show(_ next: RmApproveParams) {
            current = next
            let rebuilt = RmWindowContent.build(next, iconCache: iconCache)
            model.refresh(items: rebuilt.items, summary: rebuilt.summary)
        }
        rmFollowUpdates(
            onUpdate: { update in
                logClick("rm.approve update path=\(update.path) bytes=\(update.bytes.map(String.init) ?? "-")")
                show(current.applying(update))
            },
            onEnd: { show(current.endingUpdates()) })
    }
}
