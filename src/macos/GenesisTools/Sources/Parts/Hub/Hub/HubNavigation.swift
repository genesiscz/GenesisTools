import AppKit
import SwiftUI

// Back and forward through what the hub showed, and the log of it: every mode switch, session, worktree, PR and
// commit, who took the hub there (a click here, an agent, a link) and why. The engine is GenesisKit's
// `NavigationHistory`; the log lives in `tools hub nav` (`~/.genesis-tools/hub/data.db`), so an agent's
// `tools hub nav open` and the hub write one list. ⌘[ and ⌘], the arrows above the mode switch, the mouse's side
// buttons and a trackpad swipe walk it (`HubModel.goBack`); ⌘Y and the clock button list it (`HubHistoryButton`).

/// The place a mode shows: the mode and what it had selected.
struct HubNavEntry: Equatable {
    var mode: HubMode
    /// The session row id, worktree path or PR id the mode shows; nil while nothing is picked yet.
    var selection: String?
}

/// A place in the history: the hub's link keys (`HubLink.linkKeys`) plus `selection`, the row the hub's own mode
/// had selected. A place the hub showed has `mode` and `selection` and is restored exactly; a place an agent named
/// (`tools hub nav open`) has link keys only and opens as that link would. Stored as a flat JSON object, which is
/// the `target` of `tools hub nav` (src/hub/lib/navigation/types.ts).
struct HubNavTarget: Codable, Hashable, Sendable {
    private(set) var fields: [String: String]

    /// The keys a place keeps, in the order `arguments` writes them.
    static let keys = ["mode", "selection", "session", "agent", "pr", "reveal", "repo", "commit", "tab", "worktree"]

    init(_ fields: [String: String]) {
        self.fields = fields.filter { Self.keys.contains($0.key) && !$0.value.isEmpty }
    }

    /// The place a mode shows, with the commit a link or an Activity row opened there.
    init(place: HubNavEntry, commit: String? = nil, repo: String? = nil) {
        var fields = ["mode": place.mode.rawValue]
        fields["selection"] = place.selection
        fields["commit"] = commit
        fields["repo"] = repo
        self.init(fields)
    }

    init(from decoder: Decoder) throws {
        self.init(try decoder.singleValueContainer().decode([String: String].self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(fields)
    }

    subscript(_ key: String) -> String? { fields[key] }

    var mode: HubMode? { fields["mode"].flatMap(HubMode.init(rawValue:)) }

    /// The hub's own place, when it has one.
    var place: HubNavEntry? {
        guard let mode, let selection = fields["selection"] else { return nil }
        return HubNavEntry(mode: mode, selection: selection)
    }

    /// The `--hub` flags of a place an agent or a link named.
    var arguments: [String] {
        Self.keys.filter { $0 != "selection" }.flatMap { key in fields[key].map { ["--\(key)", $0] } ?? [] }
    }
}

typealias HubNavHistory = NavigationHistory<HubNavTarget>

/// The commit a link or an Activity row shows in a checkout's Worktrees diff (`HubModel.showCommit`).
struct HubShownCommit: Equatable {
    /// The checkout, as the Worktrees mode selects it.
    let repo: String
    /// One sha or `<from>..<to>`, as the link wrote it.
    let commit: String
}

/// A place an agent or a link asked for, with who and why, until the hub shows it. Matched against what the hub
/// shows (`HubModel.navRequestMatches`), so a PR that loads for a few seconds still gets its note.
struct HubNavRequest {
    var actor: NavigationActor
    var note: String?
    var from: String?
    /// The entry `tools hub nav open` stored; the hub's record replaces it.
    var id: String?
    var pr: HubPRRef?
    var commit: String?
    var repo: String?
    var session: String?
    var agent: String?
    var worktree: String?
    var mode: HubMode?
    /// A history entry being shown again: its own entry takes the shown place's form instead of a new entry.
    var restoring = false
    let asked: Date

    /// Nil for a request that names no place (an overlay, `--palette`, a bare `tools hub`).
    init?(_ request: HubRequest, now: Date = Date()) {
        guard request.session != nil || request.mode != nil || request.agent != nil || request.worktree != nil
            || request.pr != nil || request.commit != nil
        else { return nil }
        actor = request.actor.flatMap(NavigationActor.init(rawValue:)) ?? .link
        note = request.note
        from = request.from
        id = request.nav
        pr = request.pr
        commit = request.commit
        repo = request.repo
        session = request.session
        agent = request.agent
        worktree = request.worktree
        mode = request.mode
        asked = now
    }

    /// How long the hub waits for the place before it forgets who asked.
    static let patience: TimeInterval = 45
    /// How long, after the request, the hub's own steps on the way (the mode switch, the old row still selected)
    /// are not taken for the person's clicks.
    static let settle: TimeInterval = 3

    /// The link keys, for an entry the hub adds without showing it (agents only add to History).
    var target: HubNavTarget {
        var fields: [String: String] = [:]
        fields["mode"] = mode?.rawValue
        fields["session"] = session
        fields["agent"] = agent
        fields["pr"] = pr.map { $0.pageURL ?? $0.label }
        fields["commit"] = commit
        fields["repo"] = repo
        fields["worktree"] = worktree
        return HubNavTarget(fields)
    }

    /// "PR #563 · commit 0751d8a971", until the hub can name it better.
    var title: String {
        let commitLabel = commit.map { "commit " + $0.split(separator: ".").filter { !$0.isEmpty }.map { String($0.prefix(10)) }.joined(separator: "..") }
        if let pr {
            return (["PR \(pr.label)"] + (commitLabel.map { [$0] } ?? [])).joined(separator: " · ")
        }
        if let commitLabel, let repo {
            return "\(commitLabel) in \((repo as NSString).lastPathComponent)"
        }
        if let worktree { return "worktree " + (worktree as NSString).lastPathComponent }
        if let agent { return "agent \(agent)" }
        if let session { return "session \(session.prefix(8))" }
        return mode?.title ?? "Hub"
    }
}

/// The log, through `tools hub nav` (the hub's resident server answers it without a new process). Every call runs
/// on `queue`, never on the main thread.
final class HubNavStore: NavigationHistoryStore, Sendable {
    typealias Target = HubNavTarget

    static let queue = DispatchQueue(label: "hub.nav.store", qos: .utility)
    let limit: Int

    init(limit: Int) {
        self.limit = limit
    }

    private struct Row: Decodable {
        let id: String
        let at: Double
        let actor: String
        let title: String
        let target: HubNavTarget
        let note: String?
        let from: String?
    }

    private struct Listing: Decodable {
        let entries: [Row]
    }

    func load() throws -> [NavigationEntry<HubNavTarget>] {
        try Self.decode(ToolsCLIRunner.run(["hub", "nav", "list", "--json", "--limit", String(limit)]))
    }

    /// `tools hub nav list --json`: `{ entries: [{ id, at (ms), actor, title, target, note?, from? }], keep, path }`.
    static func decode(_ data: Data) throws -> [NavigationEntry<HubNavTarget>] {
        try JSONDecoder().decode(Listing.self, from: data).entries.map { row in
            NavigationEntry(id: row.id, at: Date(timeIntervalSince1970: row.at / 1000), target: row.target, title: row.title,
                            actor: NavigationActor(rawValue: row.actor) ?? .user, agentSession: row.from, note: row.note)
        }
    }

    func record(_ entry: NavigationEntry<HubNavTarget>, keep: Int) throws {
        _ = try ToolsCLIRunner.run(try Self.recordArguments(entry, keep: keep))
    }

    static func recordArguments(_ entry: NavigationEntry<HubNavTarget>, keep: Int) throws -> [String] {
        let target = String(decoding: try JSONEncoder().encode(entry.target), as: UTF8.self)
        // Free text rides as `--flag=value`, so a title or a note that starts with "-" is not read as a flag.
        var args = [
            "hub", "nav", "record", "--id=\(entry.id)", "--at=\(Int64(entry.at.timeIntervalSince1970 * 1000))",
            "--actor=\(entry.actor.rawValue)", "--title=\(entry.title)", "--target=\(target)", "--keep=\(keep)",
        ]
        if let note = entry.note { args.append("--note=\(note)") }
        if let from = entry.agentSession { args.append("--from=\(from)") }
        return args
    }
}

// MARK: - Mouse buttons and swipes

/// The mouse's back and forward buttons (buttons 3 and 4) and a trackpad swipe, in the hub window only.
enum HubNavInput {
    @MainActor private static var monitor: Any?

    @MainActor
    static func install(window: NSWindow, model: HubModel) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .swipe]) { [weak window, weak model] event in
            guard let model, event.window === window else { return event }
            switch event.type {
            case .otherMouseDown where event.buttonNumber == 3:
                MainActor.assumeIsolated { model.goBack() }
                return nil
            case .otherMouseDown where event.buttonNumber == 4:
                MainActor.assumeIsolated { model.goForward() }
                return nil
            // A swipe event is the trackpad's "swipe between pages" (three fingers, or two or three,
            // in System Settings); a positive deltaX is a swipe to the right, which goes back.
            case .swipe where abs(event.deltaX) > abs(event.deltaY):
                MainActor.assumeIsolated {
                    if event.deltaX > 0 { model.goBack() } else { model.goForward() }
                }
                return nil
            default:
                return event
            }
        }
    }
}

// MARK: - Buttons

/// The back and forward arrows above the mode switch, and the history list beside them. The tooltips name where
/// each arrow goes and who took the hub there.
struct HubNavButtons: View {
    @ObservedObject var model: HubModel

    var body: some View {
        let history = model.history
        HStack(spacing: 4) {
            arrow("chevron.left", enabled: history.canGoBack,
                  tooltip: history.backEntry.map { "Back to \(Self.describe($0)) (\(HubKeymap.label("hub.go.back")))" }
                      ?? "\(HubKeymap.hint("Back", "hub.go.back")): nothing earlier") {
                model.goBack()
            }
            arrow("chevron.right", enabled: history.canGoForward,
                  tooltip: history.forwardEntry.map { "Forward to \(Self.describe($0)) (\(HubKeymap.label("hub.go.forward")))" }
                      ?? "\(HubKeymap.hint("Forward", "hub.go.forward")): nothing later") {
                model.goForward()
            }
            HubHistoryButton(model: model)
        }
    }

    /// "PR #563 Fix it", or "PR #563 Fix it, opened by an agent" for a place the person did not pick.
    static func describe(_ entry: NavigationEntry<HubNavTarget>) -> String {
        switch entry.actor {
        case .user: return entry.title
        case .agent: return "\(entry.title), opened by an agent"
        case .link: return "\(entry.title), opened by a link"
        }
    }

    private func arrow(_ symbol: String, enabled: Bool, tooltip: String, action: @escaping () -> Void) -> some View {
        IconButton(systemName: symbol, tooltip: tooltip, size: 12.5, action: action)
            .foregroundColor(enabled ? Color.white.opacity(0.85) : ReviewPalette.dim.opacity(0.45))
            .disabled(!enabled)
    }
}

/// The clock beside the arrows: every place, newest first, with who went there and why; a click hops there.
struct HubHistoryButton: View {
    @ObservedObject var model: HubModel

    var body: some View {
        IconButton(systemName: "clock.arrow.circlepath", tooltip: HubKeymap.hint("History", "hub.go.history"), size: 12) {
            model.historyOpen.toggle()
        }
        .foregroundColor(model.history.entries.isEmpty ? ReviewPalette.dim.opacity(0.6) : ReviewPalette.dim)
        .popover(isPresented: $model.historyOpen, arrowEdge: .bottom) {
            HubHistoryPopover(history: model.history) { id in
                model.historyOpen = false
                model.hop(to: id)
            }
        }
    }
}

struct HubHistoryPopover: View {
    let history: HubNavHistory
    let onHop: (String) -> Void

    var body: some View {
        NavigationHistoryList(history: history, maxHeight: 460, onHop: onHop)
            .frame(width: 400)
            .padding(.bottom, 4)
            .background(Color(nsColor: KitPalette.background))
            .environment(\.colorScheme, .dark)
    }
}
