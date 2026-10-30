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
    var git: RmApproveGit?
    var folderStats: RmApproveFolderStats?
    /// Other pending requests naming the same path.
    var alsoIn: [String]?
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

    static let trashDisposal = "trash"
    static let permanentDisposal = "permanent"

    static func build(_ params: RmApproveParams, home: String = NSHomeDirectory(), icons: Bool = true,
                      markdownApp: Bool = PathOpener.genesisMarkdownApp() != nil, now: Date = Date()) -> RmWindowContent {
        guard let request = params.request else { return lineContent(params, home: home) }

        var facts: [ApprovalFact] = []
        let why = request.why?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !why.isEmpty {
            facts.append(ApprovalFact("Reason", why))
        } else if request.asker != nil {
            facts.append(ApprovalFact("Reason", "No reason given", dimmed: true))
        }
        facts.append(ApprovalFact("Folder", VaultWindowContent.shortPath(request.cwd, home: home), help: request.cwd))
        if let asked = request.askedAt.flatMap(parseDate) {
            facts.append(ApprovalFact("Asked", "\(ago(asked, now: now)) (\(stamp(asked)))", help: request.askedAt))
        }

        // Gone items last: there is nothing to decide about them.
        let ordered = request.items.enumerated().sorted { a, b in
            (a.element.kind == "missing" ? 1 : 0, a.offset) < (b.element.kind == "missing" ? 1 : 0, b.offset)
        }.map(\.element)
        let items = ordered.map { item($0, home: home, icons: icons, markdownApp: markdownApp, now: now) }
        let ledger = "Every decision is written to the tools rm ledger."
        let isDelete = request.kind == "delete"
        return RmWindowContent(
            title: params.title,
            purpose: purpose(request),
            facts: facts,
            details: [],
            items: items,
            footnote: request.id.map { "Request \($0). \(ledger)" } ?? ledger,
            summary: isDelete ? summary(request.items) : nil,
            disposals: isDelete ? disposals(graceMinutes: request.graceMinutes) : [],
            selectable: isDelete && items.count > 1)
    }

    /// "Delete 3 of 5 items for shop-admin?" as rows are unticked; the CLI's title at the start.
    static func title(selected: Int, total: Int, who: String) -> String {
        if selected == total {
            return "Delete \(Plural.count(total, "item")) for \(who)?"
        }
        return "Delete \(selected) of \(Plural.count(total, "item")) for \(who)?"
    }

    /// "Claude Code in col-fe (develop) wants to delete these. They go to the trash, and tools rm restore brings them
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
        let span = minutes % 60 == 0 ? Plural.count(minutes / 60, "hour") : Plural.count(minutes, "minute")
        return "They go to the trash, and tools rm restore brings them back for \(span)."
    }

    /// The two ways out of a delete: the trash with its grace, or for good.
    static func disposals(graceMinutes: Int?) -> [ApprovalChoice] {
        let grace: String
        if let graceMinutes, graceMinutes > 0 {
            let span = graceMinutes % 60 == 0 ? Plural.count(graceMinutes / 60, "hour") : Plural.count(graceMinutes, "minute")
            grace = "deleted after \(span); tools rm restore brings it back until then"
        } else {
            grace = "tools rm restore brings it back until the trash is emptied"
        }
        return [
            ApprovalChoice(id: trashDisposal, title: "Move to the trash", detail: grace),
            ApprovalChoice(id: permanentDisposal, title: "Delete permanently", detail: "no way back"),
        ]
    }

    /// "5 items, 34 kB, 1 already gone".
    static func summary(_ items: [RmApproveItem]) -> String {
        let gone = items.filter { $0.kind == "missing" }.count
        let bytes = items.filter { $0.kind != "missing" }.compactMap(\.bytes).reduce(0, +)
        var parts = [Plural.count(items.count, "item")]
        if bytes > 0 { parts.append(ByteFormat.file(bytes)) }
        if gone > 0 { parts.append("\(gone) already gone") }
        return parts.joined(separator: ", ")
    }

    /// "Empty folder", "12.4 KB", "Already gone".
    static func size(_ item: RmApproveItem) -> String? {
        if item.kind == "missing" { return "Already gone" }
        if item.kind == "dir", item.empty == true { return "Empty folder" }
        guard let bytes = item.bytes else { return nil }
        if bytes == 0, item.kind == "file" { return "Empty file" }
        return ByteFormat.file(bytes)
    }

    /// "12 files, newest 2 hours ago." for a folder with stats.
    static func folderDetail(_ stats: RmApproveFolderStats?, now: Date) -> String? {
        guard let stats else { return nil }
        if stats.files == 0 { return "Empty folder." }
        let newest = stats.newestAt.flatMap(parseDate).map { ", newest \(ago($0, now: now))" } ?? ""
        let count = stats.capped == true ? "\(stats.files.formatted(.number.locale(Locale(identifier: "en_US"))))+ files" : Plural.count(stats.files, "file")
        return "\(count)\(newest)."
    }

    static func item(_ item: RmApproveItem, home: String, icons: Bool, markdownApp: Bool, now: Date = Date()) -> ApprovalItem {
        let gone = item.kind == "missing"
        let location = item.storedAt ?? item.path
        let isFolder = item.kind == "dir"
        let ext = (item.path as NSString).pathExtension.lowercased()
        return ApprovalItem(
            path: item.path,
            location: location,
            name: (item.path as NSString).lastPathComponent,
            folder: VaultWindowContent.shortPath((item.path as NSString).deletingLastPathComponent, home: home),
            size: size(item),
            reason: item.reason,
            gone: gone,
            aside: item.storedAt != nil,
            isFolder: isFolder,
            opensInMarkdown: !gone && markdownApp && ["md", "markdown"].contains(ext),
            icon: icons ? icon(for: location, isFolder: isFolder, gone: gone) : nil,
            git: item.git.map { ApprovalGitState(state: $0.state, lastCommit: $0.lastCommit) },
            detail: isFolder && !gone ? folderDetail(item.folderStats, now: now) : nil,
            alsoIn: item.alsoIn ?? [])
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
            facts.append(ApprovalFact("Folder", VaultWindowContent.shortPath(folder, home: home), help: folder))
        }

        // A fact's label is its SwiftUI id and a value shows at most 3 lines, so each item is its own fact, numbered.
        let items = params.lines.enumerated().map { index, line in ApprovalFact("\(index + 1)", line, monospaced: true) }
        facts.append(contentsOf: items.prefix(rmShownLines))
        let details = Array(items.dropFirst(rmShownLines))
        if !details.isEmpty {
            facts.append(ApprovalFact("More", "\(Plural.count(details.count, "more item")) in Details"))
        }

        return RmWindowContent(
            title: params.title,
            purpose: "Nothing changes until you approve. Deleted items go to the trash and can be restored with tools rm restore during the grace period.",
            facts: facts, details: details, items: [],
            footnote: "Every decision is written to the tools rm ledger.",
            summary: nil, disposals: [], selectable: false)
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
    if asker.provider == nil || asker.provider == "claude" {
        links.append(ApprovalLink(title: "Its terminal", symbol: "terminal") {
            logClick("rm.approve link=terminal session=\(sessionId)")
            // The launcher runs `tools` programs (`GenesisTools <program> [args]`), with the app's identity.
            let focus = Process()
            focus.executableURL = Bundle.main.executableURL
            focus.arguments = ["claude", "cmux", "focus", sessionId]
            try? focus.run()
        })
    }
    return links
}

func approveRm(_ params: RmApproveParams) {
    let content = RmWindowContent.build(params)
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
        let model = ApprovalDialogModel(
            title: content.title, purpose: content.purpose,
            symbol: "trash.fill", facts: content.facts, details: content.details, warning: nil,
            footnote: content.footnote, rememberChoices: rememberChoices, rememberNote: nil,
            allowTitle: "Use password…", deadline: Date().addingTimeInterval(rmDeadlineSeconds), identifier: "rm-approve",
            items: content.items, verifier: verifier, links: rmLinks(params.request), summary: content.summary,
            disposals: content.disposals, hint: "Esc denies · Space previews", selectable: content.selectable)
        if let asker = params.request?.asker {
            let who = asker.session ?? asker.project ?? asker.agent
            model.titleForSelection = { selected, total in RmWindowContent.title(selected: selected, total: total, who: who) }
        }

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
    }
}
