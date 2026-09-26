import AppKit
import SwiftUI

// "Open in": where an agent session or a command runs. `TerminalHost` is the seam; cmux is the
// first driver (`CmuxHost`). A future terminal app adds one conforming type and nothing else in the
// hub changes: the picker, the session sidebar section and "New session here" all speak
// `TerminalTree` / `TerminalTarget` / `TerminalLaunch`.

// MARK: - Model

/// The live layout: windows → workspaces → panes (with their rectangle) → surfaces (tabs), and the
/// agent session in each surface. Decoded from `tools ai cmux tree --json`.
struct TerminalTree: Decodable, Equatable {
    struct Frame: Decodable, Equatable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    struct Size: Decodable, Equatable {
        let width: Double
        let height: Double
    }

    struct Surface: Decodable, Equatable, Identifiable {
        let id: String
        let title: String
        let type: String
        let index: Int
        let selected: Bool
        let active: Bool
        let sessionId: String?
        let provider: String?
        let sessionHint: String?
    }

    struct Pane: Decodable, Equatable, Identifiable {
        let id: String
        let title: String
        let active: Bool
        let cwd: String?
        let frame: Frame?
        let container: Size?
        let surfaces: [Surface]
    }

    struct Workspace: Decodable, Equatable, Identifiable {
        let id: String
        let name: String
        let panes: [Pane]
    }

    struct Window: Decodable, Equatable, Identifiable {
        let id: String
        let ref: String?
        let index: Int
        let key: Bool
        let workspaces: [Workspace]

        var label: String { ref ?? "window \(index + 1)" }
    }

    let available: Bool
    let error: String?
    let windows: [Window]

    /// The surface a session runs in, if the journal places it in one.
    func surface(of sessionId: String) -> (workspace: Workspace, pane: Pane, surface: Surface)? {
        let key = sessionId.lowercased()
        for window in windows {
            for workspace in window.workspaces {
                for pane in workspace.panes {
                    if let surface = pane.surfaces.first(where: { $0.sessionId?.lowercased() == key || $0.sessionHint == String(key.prefix(8)) }) {
                        return (workspace, pane, surface)
                    }
                }
            }
        }
        return nil
    }
}

/// Where to open: the level decides what gets created.
enum TerminalTarget: Hashable {
    /// A new workspace (in this window, or the current one when nil).
    case newWorkspace(window: String?)
    /// A new pane (split) in a workspace.
    case newPane(workspace: String)
    /// A new tab in a pane.
    case newTab(workspace: String, pane: String)
    /// Type into an existing surface.
    case surface(workspace: String, surface: String)

    var label: String {
        switch self {
        case .newWorkspace(let window): return window.map { "a new workspace in \($0)" } ?? "a new workspace"
        case .newPane(let workspace): return "a new pane in \(workspace)"
        case .newTab(let workspace, let pane): return "a new tab in \(pane) (\(workspace))"
        case .surface(_, let surface): return "the existing tab \(surface)"
        }
    }
}

/// What to open.
enum TerminalLaunch {
    case resume(HubSession)
    case command([String], cwd: String, name: String)
}

protocol TerminalHost: Sendable {
    var name: String { get }
    var isAvailable: Bool { get }
    /// Blocking (spawns `tools`): call off the main thread.
    func tree() -> TerminalTree?
    /// Blocking. An error message, or nil when it opened.
    func open(_ launch: TerminalLaunch, at target: TerminalTarget) -> String?
    /// Blocking. Raise the surface a session runs in.
    func focus(sessionId: String) -> String?
    /// Blocking. Type one line into the session's pane and press Enter.
    func send(sessionId: String, text: String) -> String?
}

enum TerminalHosts {
    static let current: TerminalHost = CmuxHost()
}

// MARK: - cmux driver

/// cmux through `tools`: the tree from `tools ai cmux tree`, Claude resumes through
/// `tools claude cmux open-session`, focus through `tools claude cmux focus`. Other agents and plain
/// commands are typed into a new or existing surface with the cmux CLI until `tools cmux launch`
/// (handoff h_s8belp3o) covers every agent.
struct CmuxHost: TerminalHost {
    let name = "cmux"

    var isAvailable: Bool { Self.binary != nil }

    static var binary: String? {
        ["/Applications/cmux.app/Contents/Resources/bin/cmux", "~/.local/bin/cmux", "/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"]
            .map { ($0 as NSString).expandingTildeInPath }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func tree() -> TerminalTree? {
        let span = HubPerf.begin("cmux.tree")
        defer { span.end() }
        do {
            // Not `run`: with cmux unreachable the command prints {available: false, error} and exits 1,
            // and the picker shows that error only if the JSON is decoded despite the exit status.
            let capture = try ToolsCLIRunner.capture(["ai", "cmux", "tree", "--json"])
            return try JSONDecoder().decode(TerminalTree.self, from: capture.stdout)
        } catch {
            HubPerf.log("cmux.tree failed: \(error)")
            return nil
        }
    }

    func focus(sessionId: String) -> String? {
        do {
            _ = try ToolsCLIRunner.run(["claude", "cmux", "focus", sessionId, "--first"])
            return nil
        } catch {
            return "\(error)"
        }
    }

    func send(sessionId: String, text: String) -> String? {
        do {
            // After `--`: a line that starts with a hyphen ("- fix this") is text, not an unknown option.
            _ = try ToolsCLIRunner.run(["claude", "cmux", "send", "--first", "--", sessionId, text])
            return nil
        } catch {
            return "\(error)"
        }
    }

    func open(_ launch: TerminalLaunch, at target: TerminalTarget) -> String? {
        let span = HubPerf.begin("cmux.open", target.label)
        defer { span.end() }
        switch launch {
        case .resume(let session) where session.provider == "claude":
            if let args = Self.openSessionArgs(target) {
                do {
                    let capture = try ToolsCLIRunner.capture(["claude", "cmux", "open-session", session.sessionId] + args + ["--json"])
                    return capture.status == 0 ? nil : Self.failure(of: capture)
                } catch {
                    return "\(error)"
                }
            }
            guard let command = AgentLauncher.resumeCommand(for: session) else { return "no resume command for \(session.provider)" }
            return run(command, cwd: session.cwd, name: session.displayTitle, at: target)
        case .resume(let session):
            guard let command = AgentLauncher.resumeCommand(for: session) else { return "no resume command for \(session.provider)" }
            return run(command, cwd: session.cwd, name: session.displayTitle, at: target)
        case .command(let command, let cwd, let name):
            return run(command, cwd: cwd, name: name, at: target)
        }
    }

    /// `open-session --json` reports a failure as {ok: false, error} on stdout, with stderr empty.
    private static func failure(of capture: ProcessCapture) -> String {
        struct Failure: Decodable { let error: String }
        if let failure = try? JSONDecoder().decode(Failure.self, from: capture.stdout) {
            return failure.error
        }
        let stderr = String(decoding: capture.stderr, as: UTF8.self).trimmed
        return stderr.isEmpty ? "tools claude cmux open-session exited \(capture.status)" : String(stderr.suffix(300))
    }

    private static func openSessionArgs(_ target: TerminalTarget) -> [String]? {
        switch target {
        case .newWorkspace(let window): return window.map { ["--window", $0] }
        case .newPane(let workspace): return ["--workspace", workspace]
        case .newTab(let workspace, let pane): return ["--workspace", workspace, "--pane", pane]
        case .surface(let workspace, let surface): return ["--workspace", workspace, "--surface", surface]
        }
    }

    /// Words are shell-quoted here because cmux takes one command string; nothing in them comes from a URL.
    private func run(_ command: [String], cwd: String, name: String, at target: TerminalTarget) -> String? {
        let words = command.map(Self.quote).joined(separator: " ")
        let line = cwd.isEmpty ? words : "cd \(Self.quote(cwd)) && \(words)"
        switch target {
        case .newWorkspace(let window):
            let result = Self.cmux(["new-workspace", "--name", name, "--cwd", cwd, "--command", words, "--focus", "true"] + (window.map { ["--window", $0] } ?? []))
            return result.ok ? nil : result.out.trimmed
        case .newPane(let workspace):
            return typeInto(Self.cmux(["new-pane", "--type", "terminal", "--direction", "right", "--workspace", workspace, "--focus", "true"]), workspace: workspace, line: line)
        case .newTab(let workspace, let pane):
            return typeInto(Self.cmux(["new-surface", "--type", "terminal", "--workspace", workspace, "--pane", pane, "--focus", "true"]), workspace: workspace, line: line)
        case .surface(let workspace, let surface):
            return send(line, workspace: workspace, surface: surface)
        }
    }

    /// new-surface / new-pane print the new surface ref; the command is typed into it, then Enter.
    private func typeInto(_ created: (ok: Bool, out: String), workspace: String, line: String) -> String? {
        guard created.ok else { return created.out.trimmed }
        guard let range = created.out.range(of: "surface:[0-9]+", options: .regularExpression) else {
            return "cmux did not report the new surface: \(created.out.trimmed)"
        }
        return send(line, workspace: workspace, surface: String(created.out[range]))
    }

    private func send(_ line: String, workspace: String, surface: String) -> String? {
        let sent = Self.cmux(["send", "--workspace", workspace, "--surface", surface, line])
        guard sent.ok else { return sent.out.trimmed }
        let enter = Self.cmux(["send-key", "--workspace", workspace, "--surface", surface, "Enter"])
        return enter.ok ? nil : enter.out.trimmed
    }

    @discardableResult
    static func cmux(_ args: [String]) -> (ok: Bool, out: String) {
        guard let binary else { return (false, "cmux is not installed") }
        let span = HubPerf.begin("cmux.\(args.first ?? "")")
        defer { span.end() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = args
        var environment = ProcessInfo.processInfo.environment
        environment["CMUX_QUIET"] = "1"
        process.environment = environment
        guard let result = try? process.runCapturing() else { return (false, "cmux failed to start") }
        let text = String(decoding: result.stdout, as: UTF8.self)
        return (result.status == 0, result.status == 0 ? text : String(decoding: result.stderr, as: UTF8.self) + text)
    }

    static func quote(_ word: String) -> String {
        if word.range(of: "^[A-Za-z0-9_./:=@%+,-]+$", options: .regularExpression) != nil {
            return word
        }
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

// MARK: - Loading the tree off the main thread

@MainActor
final class TerminalTreeModel: ObservableObject {
    @Published private(set) var tree: TerminalTree?
    @Published private(set) var loading = false
    let host: TerminalHost

    init(host: TerminalHost = TerminalHosts.current) {
        self.host = host
    }

    func load() {
        guard !loading else { return }
        loading = true
        let host = host
        Task {
            let fetched = await Task.detached(priority: .userInitiated) { host.tree() }.value
            tree = fetched
            loading = false
        }
    }
}

// MARK: - Picker (tree or layout)

/// Where to open something, as a tree (window → workspace → pane → tab, each with what a click does)
/// or as the real layout (pane rectangles as cmux draws them). With `selection` it only marks the
/// choice (the launch sheet confirms); without it a click opens right away through `onPick`.
struct TerminalTargetPicker: View {
    /// "tree" or "layout", shared by every picker (and read by `LaunchPicker` to size its popover).
    static let modeKey = "hub.terminal.pickerMode"

    @ObservedObject var model: TerminalTreeModel
    var selection: TerminalTarget?
    var highlightSession: String?
    /// How wide the inline layout draws the panes (the launch popover widens for it).
    var layoutWidth: CGFloat = 300
    let onPick: (TerminalTarget) -> Void

    @AppStorage(TerminalTargetPicker.modeKey) private var mode = "tree"
    @State private var layoutOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Picker("", selection: $mode) {
                    Text("Tree").tag("tree")
                    Text("Layout").tag("layout")
                }
                .pickerStyle(.segmented)
                .frame(width: 130)
                .instantTooltip("Tree: every window, workspace, pane and tab. Layout: the panes where cmux draws them")
                IconButton(systemName: "arrow.up.left.and.arrow.down.right", tooltip: "Open the layout in a large popover") {
                    layoutOpen = true
                }
                .popover(isPresented: $layoutOpen, arrowEdge: .leading) {
                    ScrollView {
                        TerminalLayoutView(tree: model.tree, selection: selection, highlightSession: highlightSession, width: 760) { target in
                            onPick(target)
                            layoutOpen = false
                        }
                        .padding(14)
                    }
                    .frame(width: 800, height: 600)
                    .background(Color(nsColor: ReviewPalette.background))
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Reload the cmux layout") { model.load() }
                if model.loading {
                    ProgressView().controlSize(.mini)
                }
            }
            if let tree = model.tree, !tree.available {
                Text(verbatim: tree.error ?? "cmux is not reachable")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.removed)
            } else if mode == "layout" {
                TerminalLayoutView(tree: model.tree, selection: selection, highlightSession: highlightSession, width: layoutWidth, onPick: onPick)
            } else {
                TerminalTreeList(tree: model.tree, selection: selection, highlightSession: highlightSession, onPick: onPick)
            }
        }
        .onAppear {
            if model.tree == nil {
                model.load()
            }
        }
    }
}

/// The Genesis-style tree: each level says what a click creates.
struct TerminalTreeList: View {
    let tree: TerminalTree?
    let selection: TerminalTarget?
    let highlightSession: String?
    let onPick: (TerminalTarget) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(tree?.windows ?? []) { window in
                row(.newWorkspace(window: window.ref ?? window.id), indent: 0, label: window.label, hint: "new workspace", symbol: "macwindow")
                ForEach(window.workspaces) { workspace in
                    row(.newPane(workspace: workspace.id), indent: 1, label: workspace.name, hint: "new pane", symbol: "rectangle.split.2x1")
                    ForEach(workspace.panes) { pane in
                        row(.newTab(workspace: workspace.id, pane: pane.id), indent: 2, label: pane.id, hint: "new tab", symbol: "plus.square")
                        ForEach(pane.surfaces) { surface in
                            row(.surface(workspace: workspace.id, surface: surface.id), indent: 3, label: surface.title, hint: "type here", symbol: "terminal", session: surface)
                        }
                    }
                }
            }
        }
    }

    private func row(_ target: TerminalTarget, indent: Int, label: String, hint: String, symbol: String, session: TerminalTree.Surface? = nil) -> some View {
        let chosen = selection == target
        let mine = highlightSession.map { id in session?.sessionId?.lowercased() == id.lowercased() } ?? false
        return Button { onPick(target) } label: {
            HStack(spacing: 5) {
                Color.clear.frame(width: CGFloat(indent) * 12, height: 1)
                Image(systemName: symbol).font(.system(size: 9.5)).foregroundColor(ReviewPalette.dim).frame(width: 12)
                if let provider = session?.provider {
                    ProviderLetter(provider: provider, sessionId: session?.sessionId)
                }
                Text(verbatim: label)
                    .font(.system(size: 11, weight: indent < 2 ? .semibold : .regular, design: indent == 2 ? .monospaced : .default))
                    .foregroundColor(mine ? Color.accentColor : Color.white.opacity(indent == 3 ? 0.8 : 0.9))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 6)
                Text(verbatim: mine ? "this session" : hint)
                    .font(.system(size: 10))
                    .foregroundColor(chosen ? Color.accentColor : ReviewPalette.dim)
            }
            .padding(.vertical, 3)
            .padding(.horizontal, 5)
            .background(RoundedRectangle(cornerRadius: 5).fill(chosen ? Color.accentColor.opacity(0.18) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 5))
        .instantTooltip("Open in \(target.label)")
    }
}

/// The agent's initial on a tab that holds a session (C, X, G).
private struct ProviderLetter: View {
    let provider: String
    let sessionId: String?

    var body: some View {
        Text(verbatim: String(provider.prefix(1)).uppercased())
            .font(.system(size: 8.5, weight: .bold))
            .foregroundColor(.black)
            .frame(width: 12, height: 12)
            .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.7)))
            .instantTooltip("\(provider) session \(sessionId?.prefix(8) ?? "")")
    }
}

/// Each workspace drawn as cmux lays it out: pane rectangles from `pixel_frame`, their tabs on top.
/// Click a pane for a new tab, a tab to type into it, the workspace title for a new pane, the window
/// title for a new workspace.
struct TerminalLayoutView: View {
    let tree: TerminalTree?
    let selection: TerminalTarget?
    let highlightSession: String?
    let width: CGFloat
    let onPick: (TerminalTarget) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(tree?.windows ?? []) { window in
                Button { onPick(.newWorkspace(window: window.ref ?? window.id)) } label: {
                    Label(window.label + (window.key ? " (front)" : ""), systemImage: "macwindow")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(Color.white.opacity(0.9))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open in a new workspace in \(window.label)")
                ForEach(window.workspaces) { workspace in
                    workspaceView(workspace)
                }
            }
        }
    }

    private struct Placed: Identifiable {
        let pane: TerminalTree.Pane
        let frame: TerminalTree.Frame
        var id: String { pane.id }
    }

    private func workspaceView(_ workspace: TerminalTree.Workspace) -> some View {
        let placed = workspace.panes.compactMap { pane in pane.frame.map { Placed(pane: pane, frame: $0) } }
        let minX = placed.map(\.frame.x).min() ?? 0
        let minY = placed.map(\.frame.y).min() ?? 0
        let maxX = placed.map { $0.frame.x + $0.frame.width }.max() ?? 1
        let maxY = placed.map { $0.frame.y + $0.frame.height }.max() ?? 1
        let scale = width / max(maxX - minX, 1)
        let height = max((maxY - minY) * scale, 40)
        return VStack(alignment: .leading, spacing: 4) {
            Button { onPick(.newPane(workspace: workspace.id)) } label: {
                HStack(spacing: 5) {
                    Image(systemName: "rectangle.split.2x1").font(.system(size: 10))
                    Text(verbatim: workspace.name).font(.system(size: 11, weight: .medium)).lineLimit(1)
                }
                .foregroundColor(ReviewPalette.dim)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Split: a new pane in \(workspace.name)")
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35))
                ForEach(placed) { item in
                    paneView(item.pane, workspace: workspace)
                        .frame(width: max(item.frame.width * scale - 3, 10), height: max(item.frame.height * scale - 3, 10))
                        .offset(x: (item.frame.x - minX) * scale + 1.5, y: (item.frame.y - minY) * scale + 1.5)
                }
            }
            .frame(width: width, height: height)
        }
    }

    private func paneView(_ pane: TerminalTree.Pane, workspace: TerminalTree.Workspace) -> some View {
        let paneTarget = TerminalTarget.newTab(workspace: workspace.id, pane: pane.id)
        let hasMine = highlightSession.map { id in pane.surfaces.contains { $0.sessionId?.lowercased() == id.lowercased() } } ?? false
        // The pane is a container, not a button: a surface button inside a pane button left VoiceOver
        // and the keyboard unable to tell "type into this surface" from "new tab in this pane".
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(pane.surfaces) { surface in
                let target = TerminalTarget.surface(workspace: workspace.id, surface: surface.id)
                Button { onPick(target) } label: {
                    HStack(spacing: 3) {
                        if let provider = surface.provider {
                            Text(verbatim: String(provider.prefix(1)).uppercased()).font(.system(size: 8, weight: .bold))
                        }
                        Text(verbatim: surface.title).font(.system(size: 9.5)).lineLimit(1).truncationMode(.middle)
                    }
                    .foregroundColor(surface.selected ? Color.white : ReviewPalette.dim)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 3).fill(selection == target ? Color.accentColor.opacity(0.35) : Color.white.opacity(surface.selected ? 0.12 : 0.05)))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Type into \(surface.title)")
            }
            Spacer(minLength: 0)
        }
        // Room for the new-tab button in the top-right corner.
        .padding(.trailing, 16)
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(selection == paneTarget ? Color.accentColor.opacity(0.18) : Color.white.opacity(pane.active ? 0.07 : 0.03))
        )
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(hasMine ? Color.accentColor : Color.white.opacity(0.12), lineWidth: hasMine ? 1.5 : 1))
        .overlay(alignment: .topTrailing) {
            IconButton(systemName: "plus.rectangle", tooltip: "New tab in \(pane.id)", size: 10) { onPick(paneTarget) }
                .padding(2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Pane \(pane.id)"))
    }
}

// MARK: - Session sidebar section

/// The Genesis "Cmux" sidebar block for the hub: where the session is, focus it, resume it in its
/// last pane, or pick any pane (tree or layout).
struct SessionTerminalSection: View {
    let session: HubSession
    @StateObject private var model = TerminalTreeModel()
    @State private var choosing = false
    @State private var busy = false
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: model.host.name.uppercased())
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
            if let refs = refsLine {
                Text(verbatim: refs)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .textSelection(.enabled)
            }
            HStack(spacing: 6) {
                if model.tree?.surface(of: session.sessionId) != nil {
                    ghost("Focus", symbol: "scope", tip: "Raise the tab this session runs in") {
                        await perform { $0.focus(sessionId: session.sessionId) }
                    }
                }
                if let last = lastPane {
                    ghost("Open in last pane", symbol: "rectangle.portrait.and.arrow.right", tip: "Resume in the pane it last ran in, as a new tab") {
                        await perform { $0.open(.resume(session), at: last) }
                    }
                }
                ghost(choosing ? "Hide targets" : "Choose a pane…", symbol: "square.grid.2x2", tip: "Pick a window, workspace, pane or tab to resume this session in") {
                    choosing.toggle()
                }
            }
            if let notice {
                NoticePill(text: notice, isError: notice != "Opened") { self.notice = nil }
            }
            if choosing {
                TerminalTargetPicker(model: model, highlightSession: session.sessionId) { target in
                    Task { await perform { $0.open(.resume(session), at: target) } }
                }
            }
        }
        .disabled(busy)
        .onAppear { model.load() }
    }

    private var refsLine: String? {
        guard let cmux = session.cmux else { return nil }
        let parts = [cmux.windowRef, cmux.workspaceRef, cmux.paneRef, cmux.surfaceRef].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var lastPane: TerminalTarget? {
        guard let cmux = session.cmux, let workspace = cmux.workspaceRef, let pane = cmux.paneRef else { return nil }
        return .newTab(workspace: workspace, pane: pane)
    }

    private func perform(_ action: @escaping @Sendable (TerminalHost) -> String?) async {
        busy = true
        let host = model.host
        let error = await Task.detached(priority: .userInitiated) { action(host) }.value
        busy = false
        notice = error.map { "\(host.name): \($0)" } ?? "Opened"
        model.load()
    }

    private func ghost(_ title: String, symbol: String, tip: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10.5))
                Text(verbatim: title).font(.system(size: 11.5, weight: .medium))
            }
            .foregroundColor(Color.white.opacity(0.85))
            .padding(.horizontal, 9)
            .frame(height: 26)
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.12)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tip)
    }
}

// MARK: - New session / resume sheet

enum AgentHarness: String, CaseIterable {
    case claude, codex, grok

    var title: String { rawValue.capitalized }

    func newCommand(account: String, prompt: String? = nil) -> [String] {
        let first = prompt.map { [$0] } ?? []
        switch self {
        case .claude:
            let run = account.isEmpty ? ["tools", "claude", "run"] : ["tools", "claude", "run", account]
            return run + (first.isEmpty ? [] : ["--"] + first)
        case .codex: return ["codex"] + first
        case .grok: return ["grok"] + first
        }
    }
}

/// How a `LaunchPicker` ended. Callers act on the case, never on the wording: a resume that failed
/// must not look like one that worked.
enum LaunchOutcome: Equatable {
    case cancelled
    /// The session started or resumed; the label names it ("Resume: fix the cart").
    case launched(String)
    /// The terminal host refused; the reason starts with the host's name.
    case failed(String)

    /// The line a caller shows; nil for Cancel.
    var notice: String? {
        switch self {
        case .cancelled: return nil
        case .launched(let text), .failed(let text): return text
        }
    }
}

/// The popover behind "New session here" and "Resume". Shows the command, the folder and the target
/// before anything runs.
struct LaunchPicker: View {
    enum Mode {
        /// `prompt`: the agent's first message, passed on its command line after the command.
        case new(cwd: String, name: String, prompt: String? = nil)
        case resume(HubSession)
    }

    let mode: Mode
    let done: (LaunchOutcome) -> Void

    @State private var harness = AgentHarness.claude
    @AppStorage("hub.launch.account") private var account = ""
    @StateObject private var model = TerminalTreeModel()
    @State private var target = TerminalTarget.newWorkspace(window: nil)
    @State private var busy = false
    @AppStorage(TerminalTargetPicker.modeKey) private var pickerMode = "tree"
    @State private var targetsHeight: CGFloat = 0

    /// The popover's width: the tree fits the narrow one; the layout gets room to draw real panes.
    static let narrowWidth: CGFloat = 460
    static let wideWidth: CGFloat = 800
    private var wide: Bool { pickerMode == "layout" }

    private var cwd: String {
        switch mode {
        case .new(let cwd, _, _): return cwd
        case .resume(let session): return session.cwd
        }
    }

    private var command: [String] {
        switch mode {
        case .new(_, _, let prompt): return harness.newCommand(account: account.trimmed, prompt: prompt)
        case .resume(let session): return AgentLauncher.resumeCommand(for: session) ?? []
        }
    }

    private var name: String {
        switch mode {
        case .new(_, let name, _): return name
        case .resume(let session): return session.displayTitle
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if case .new = mode {
                Picker("", selection: $harness) {
                    ForEach(AgentHarness.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .instantTooltip("Which agent to start")
                if harness == .claude {
                    TextField("Account (empty = pick in the terminal)", text: $account)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                        .instantTooltip("tools claude run <account>")
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Where (\(model.host.name))").font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                ScrollView {
                    // The width the layout gets: the wide popover less its padding and the scroller.
                    TerminalTargetPicker(model: model, selection: target, layoutWidth: Self.wideWidth - 28 - 16) { target = $0 }
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { targetsHeight = $0 }
                }
                // As tall as the targets, up to a cap. With only a maximum the popover sized the scroll
                // view to its minimum, and the tree or layout under the switch never showed
                // (screenshot 2026-09-24 19:55).
                .frame(height: min(max(targetsHeight, 30), wide ? 420 : 260))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("Will run").font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                Text(command.map(CmuxHost.quote).joined(separator: " "))
                    .font(.system(size: 11.5, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35)))
                PathLabel(path: cwd, showIcons: false)
                Text("in \(target.label)").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
            }
            HStack {
                Spacer()
                Button("Cancel") { done(.cancelled) }
                Button(buttonTitle) { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(command.isEmpty || busy)
            }
        }
        .padding(14)
        // Layout widens the popover so the panes draw at a readable size; Tree narrows it again.
        // The same component backs "Start an agent here" and "Resume", so both do it.
        .frame(width: wide ? Self.wideWidth : Self.narrowWidth)
        .animation(.snappy(duration: 0.3), value: wide)
    }

    @ViewBuilder
    private var header: some View {
        switch mode {
        case .new:
            Text("Start an agent here").font(.system(size: 13, weight: .semibold))
        case .resume(let session):
            // The session's own name and id, so the popover says which session it resumes.
            VStack(alignment: .leading, spacing: 5) {
                Text("Resume").font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                Text(session.displayTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    CopyChip(label: String(session.sessionId.prefix(8)), value: session.sessionId, tooltip: "Copy the full session id: \(session.sessionId)")
                    LiveAgo(date: session.lastActivity) { ago in
                        [AIProviders.meta(for: session.provider).displayName, session.account, ago.isEmpty ? nil : ago]
                            .compactMap { $0 }.joined(separator: " · ")
                    }
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                }
            }
        }
    }

    private func start() {
        let launch: TerminalLaunch
        switch mode {
        case .new: launch = .command(command, cwd: cwd, name: name)
        case .resume(let session): launch = .resume(session)
        }
        let host = model.host
        let target = target
        let label = "\(buttonTitle): \(name)"
        busy = true
        Task {
            let error = await Task.detached(priority: .userInitiated) { host.open(launch, at: target) }.value
            busy = false
            done(error.map { .failed("\(host.name): \($0)") } ?? .launched(label))
        }
    }

    private var buttonTitle: String {
        switch mode {
        case .new: return "Start"
        case .resume: return "Resume"
        }
    }
}
