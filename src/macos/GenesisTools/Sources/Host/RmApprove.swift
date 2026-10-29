// The safe delete's approval window (`--rpc {"method":"rm.approve"}`).
//
// `tools rm approve <id>`, `tools rm config set` and the other commands that need a person ask here when the rm
// setting `approval` allows Touch ID. The window shows what will happen (each item with its icon, size and reason, and
// buttons that open it), and Touch ID listens inside the window from the first frame: a touch on the sensor approves,
// no click needed (Martin, 2026-10-29). "Use password…" asks for the account password instead. An agent can open the
// window and even press its buttons, but it cannot touch the sensor or type the password, which the typed code and the
// AppleScript dialog could not promise. The reply is the decision and how it was confirmed; the CLI does the deletion.
// A deny and a timeout reply "deny"; a failed or cancelled touch only lets the person try again.

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
}

struct RmApproveRequest: Decodable {
    /// nil for a run a person confirms at once (`tools rm <paths>` on a terminal).
    var id: String?
    /// "delete" or "root".
    var kind: String
    var why: String?
    var cwd: String
    var graceMinutes: Int?
    var asker: RmApproveAsker?
    var items: [RmApproveItem]
}

struct RmApproveAsker: Decodable {
    /// The display name, e.g. "Claude Code".
    var agent: String
    var session: String?
    var project: String?
    var branch: String?
}

struct RmApproveItem: Decodable {
    var path: String
    /// "file", "dir", "symlink" or "missing".
    var kind: String
    var bytes: Int64?
    var empty: Bool?
    var storedAt: String?
    var reason: String
}

/// The CLI waits 180 s; this side gives up a little earlier and says why.
private let rmDeadlineSeconds: Double = 170

/// Without rows, the window shows this many lines; the rest are folded into Details.
private let rmShownLines = 6

private func rmEmit(decision: String, method: String, reason: String) -> Never {
    logClick("rm.approve decision=\(decision) method=\(method) reason=\(reason)")
    emitResult(["decision": decision, "method": method, "reason": reason])
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

    static func build(_ params: RmApproveParams, home: String = NSHomeDirectory(), icons: Bool = true,
                      markdownApp: Bool = PathOpener.genesisMarkdownApp() != nil) -> RmWindowContent {
        guard let request = params.request else { return lineContent(params, home: home) }

        var facts: [ApprovalFact] = []
        if let why = request.why?.trimmingCharacters(in: .whitespacesAndNewlines), !why.isEmpty {
            facts.append(ApprovalFact("Reason", why))
        }
        facts.append(ApprovalFact("Folder", VaultWindowContent.shortPath(request.cwd, home: home), help: request.cwd))

        let items = request.items.map { item($0, home: home, icons: icons, markdownApp: markdownApp) }
        let ledger = "Every decision is written to the tools rm ledger."
        return RmWindowContent(
            title: params.title,
            purpose: purpose(request),
            facts: facts,
            details: [],
            items: items,
            footnote: request.id.map { "Request \($0). \(ledger)" } ?? ledger)
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

    /// "Empty folder", "12.4 KB", "Already gone".
    static func size(_ item: RmApproveItem) -> String? {
        if item.kind == "missing" { return "Already gone" }
        if item.kind == "dir", item.empty == true { return "Empty folder" }
        guard let bytes = item.bytes else { return nil }
        if bytes == 0, item.kind == "file" { return "Empty file" }
        return ByteFormat.file(bytes)
    }

    static func item(_ item: RmApproveItem, home: String, icons: Bool, markdownApp: Bool) -> ApprovalItem {
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
            icon: icons ? icon(for: location, isFolder: isFolder, gone: gone) : nil)
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
            footnote: "Every decision is written to the tools rm ledger.")
    }
}

@MainActor private let rmPresenter = ApprovalPanelPresenter()

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
        let model = ApprovalDialogModel(
            title: content.title, purpose: content.purpose,
            symbol: "trash.fill", facts: content.facts, details: content.details, warning: nil,
            footnote: content.footnote, rememberChoices: [], rememberNote: nil,
            allowTitle: "Use password…", deadline: Date().addingTimeInterval(rmDeadlineSeconds), identifier: "rm-approve",
            items: content.items, verifier: verifier)

        let deadline = DispatchWorkItem {
            verifier.cancel()
            record("denied", ["detail": "no answer within \(Int(rmDeadlineSeconds))s"])
            rmEmit(decision: "deny", method: "none", reason: "no answer within \(Int(rmDeadlineSeconds))s")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + rmDeadlineSeconds, execute: deadline)

        model.onDeny = {
            deadline.cancel()
            rmPresenter.close()
            record("denied", ["detail": "denied in the approval window"])
            rmEmit(decision: "deny", method: "none", reason: "denied in the approval window")
        }

        model.onVerified = { method, _ in
            deadline.cancel()
            rmPresenter.close()
            record("allowed", ["method": method])
            rmEmit(decision: "allow", method: method, reason: "")
        }

        let shown = content.facts + content.details + content.items.map { ApprovalFact($0.path, $0.reason) }
        record("prompted", ["shown": GateAudit.shown(title: content.title, purpose: model.purpose, facts: shown, warning: nil, onceOnly: "only once")])
        rmPresenter.present(model)
    }
}
