import AppKit
import SwiftUI

// "Open in": where an agent session or a command runs. `TerminalHost` is the seam; cmux is the
// first driver (`CmuxHost`). The tree, the target and the picker are shared with Genesis
// (GenesisKit: `CmuxTree`, `CmuxTarget`, `CmuxTargetPicker`, `CmuxSessionPanel`).

/// What to open.
enum TerminalLaunch {
    case resume(HubSession)
    case command([String], cwd: String, name: String)
}

protocol TerminalHost: Sendable {
    var name: String { get }
    var isAvailable: Bool { get }
    /// Blocking (spawns `tools`): call off the main thread.
    func tree() -> CmuxTree?
    /// Blocking. An error message, or nil when it opened.
    func open(_ launch: TerminalLaunch, at target: CmuxTarget) -> String?
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

    func tree() -> CmuxTree? {
        let span = HubPerf.begin("cmux.tree")
        defer { span.end() }
        do {
            // Not `run`: with cmux unreachable the command prints {available: false, error} and exits 1,
            // and the picker shows that error only if the JSON is decoded despite the exit status.
            let capture = try ToolsCLIRunner.capture(["ai", "cmux", "tree", "--json"])
            return try CmuxTree.decode(capture.stdout)
        } catch {
            HubPerf.log("cmux.tree failed: \(error)")
            return nil
        }
    }

    func focus(sessionId: String) -> String? {
        do {
            let capture = try ToolsCLIRunner.capture(["claude", "cmux", "focus", sessionId, "--first", "--json"])
            return Self.focusFailure(status: capture.status, stdout: capture.stdout, stderr: capture.stderr)
        } catch {
            return "\(error)"
        }
    }

    /// What `tools claude cmux focus --json` said, in words: nil when it focused. A recorded tab that
    /// was closed answers `gone`; before, the hub and Genesis showed cmux's raw "[socket] RPC error".
    static func focusFailure(status: Int32, stdout: Data, stderr: Data) -> String? {
        guard status != 0 else { return nil }
        struct Opaque: Decodable {
            init(from decoder: Decoder) throws {}
        }
        struct Result: Decodable {
            let gone: Bool?
            let matches: [Opaque]?
        }
        if let result = try? JSONDecoder().decode(Result.self, from: stdout) {
            if result.gone == true {
                return CmuxHost.paneGone
            }
            if result.matches?.isEmpty == true {
                return "No cmux pane shows this session. Choose a pane to resume it in."
            }
        }
        let lines = String(decoding: stderr, as: UTF8.self).split(whereSeparator: \.isNewline)
        let said = lines.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "│■▲● ").union(.whitespaces)) }.last { !$0.isEmpty }
        return said.map { String($0) } ?? "tools claude cmux focus exited \(status)"
    }

    static let paneGone = "That cmux pane is gone. Choose a pane to resume the session in."

    func send(sessionId: String, text: String) -> String? {
        do {
            // After `--`: a line that starts with a hyphen ("- fix this") is text, not an unknown option.
            _ = try ToolsCLIRunner.run(["claude", "cmux", "send", "--first", "--", sessionId, text])
            return nil
        } catch {
            return "\(error)"
        }
    }

    func open(_ launch: TerminalLaunch, at target: CmuxTarget) -> String? {
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

    private static func openSessionArgs(_ target: CmuxTarget) -> [String]? {
        target.openSessionArgs
    }

    /// Words are shell-quoted here because cmux takes one command string; nothing in them comes from a URL.
    private func run(_ command: [String], cwd: String, name: String, at target: CmuxTarget) -> String? {
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
    @Published private(set) var tree: CmuxTree?
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

/// The Tree / Layout choice every hub picker shares (and `LaunchPicker` reads to size its popover).
enum HubCmuxPicker {
    static let modeKey = "hub.terminal.pickerMode"
}

// MARK: - Session sidebar section

/// The Genesis "Cmux" sidebar block for the hub: where the session is, focus it, resume it in its
/// last pane, or pick any pane (tree or layout).
struct SessionTerminalSection: View {
    let session: HubSession
    @StateObject private var model = TerminalTreeModel()
    // `--set hub.session.cmuxTargetsOpen=true`: a snapshot with the target tree open.
    @State private var choosing = HubDefaults.store.bool(forKey: "hub.session.cmuxTargetsOpen")
    @State private var busy = false
    @State private var notice: CmuxSessionPanel.Notice?

    var body: some View {
        let cmux = session.cmux
        CmuxSessionPanel(
            sessionId: session.sessionId,
            window: cmux?.windowRef,
            workspace: cmux?.workspaceRef,
            pane: cmux?.paneRef,
            surface: cmux?.surfaceRef,
            tree: model.tree,
            loading: model.loading,
            busy: busy,
            lastPane: CmuxTarget.lastPane(workspace: cmux?.workspaceRef, pane: cmux?.paneRef, surface: nil),
            choosing: $choosing,
            notice: $notice,
            modeKey: HubCmuxPicker.modeKey,
            modeStore: HubDefaults.store,
            focus: { Task { await perform { $0.focus(sessionId: session.sessionId) } } },
            open: { target in Task { await perform { $0.open(.resume(session), at: target) } } },
            reload: { model.load() }
        )
        .onAppear { model.load() }
    }


    private func perform(_ action: @escaping @Sendable (TerminalHost) -> String?) async {
        busy = true
        let host = model.host
        let error = await Task.detached(priority: .userInitiated) { action(host) }.value
        busy = false
        if error == CmuxHost.paneGone {
            // The tab it ran in is closed: say so in words and show where it can go instead.
            notice = CmuxSessionPanel.Notice(text: CmuxHost.paneGone, isError: true)
            choosing = true
        } else {
            notice = CmuxSessionPanel.Notice(text: error.map { "\(host.name): \($0)" } ?? "Opened", isError: error != nil)
        }
        model.load()
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
    @State private var target = CmuxTarget.newWorkspace(window: nil)
    @State private var busy = false
    @AppStorage(HubCmuxPicker.modeKey, store: HubDefaults.store) private var pickerMode = "tree"
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
                    CmuxTargetPicker(tree: model.tree, loading: model.loading, selection: target, modeKey: HubCmuxPicker.modeKey, modeStore: HubDefaults.store, reload: { model.load() }) { target = $0 }
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { targetsHeight = $0 }
                        .onAppear {
                            if model.tree == nil {
                                model.load()
                            }
                        }
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
