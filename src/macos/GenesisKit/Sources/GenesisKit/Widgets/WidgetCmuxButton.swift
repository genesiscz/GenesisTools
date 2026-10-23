import SwiftUI

/// The cmux button every widget session carries: a popover with the shared `CmuxSessionPanel` (Focus, open in a pane,
/// choose a pane), the same block the hub's session sidebar shows. The widget drives it through its own `tools`
/// bridge; the pane moves go through GenesisKit's `CmuxCommandRunner`, which the hub's `CmuxHost` uses too.
struct WidgetCmuxButton: View {
    @ObservedObject var model: WidgetModel
    let session: WidgetSession
    var size: CGFloat = 11
    /// In a list, false on every row but the hovered or selected one: the row then carries no button, tooltip or
    /// hover sensor, because an accessibility client walks every control of every row per update (swift skill,
    /// "Dense lists and accessibility clients"). The popover stays attached, so an open one survives the pointer leaving.
    var live = true
    @State private var open = false

    var body: some View {
        Group {
            if live || open {
                IconButton(systemName: "terminal", tooltip: "cmux: focus this session, or resume it in a pane", size: size) {
                    open = true
                }
                .accessibilityLabel("cmux for " + session.title)
                .accessibilityIdentifier("widget.cmux." + session.key)
            } else {
                Color.clear.frame(width: size + 13, height: size + 13).accessibilityHidden(true)
            }
        }
        .popover(isPresented: $open, arrowEdge: .trailing) {
            WidgetCmuxPanel(model: model, session: session).padding(14).frame(width: 380)
        }
        // The popover takes the pointer out of the edge panel; while it is open the panel must not collapse. Its own
        // flag, as the session chooser has one: closing it must never release a window the host opened.
        .onChange(of: open) { _, value in model.cmuxPopoverOpen = value }
        .onDisappear { if open { model.cmuxPopoverOpen = false } }
    }
}

/// A list row that knows whether the pointer is on it, for `WidgetCmuxButton(live:)` and its other row-only controls.
struct WidgetHoverRow<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @State private var hovering = false

    var body: some View {
        content(hovering).onHover { hovering = $0 }
    }
}

struct WidgetCmuxPanel: View {
    @ObservedObject var model: WidgetModel
    let session: WidgetSession
    @State private var tree: CmuxTree?
    @State private var loading = false
    @State private var busy = false
    @State private var choosing = false
    @State private var notice: CmuxSessionPanel.Notice?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(2)
                Text([AIProviders.meta(for: session.target.provider).displayName, session.project,
                      String(session.target.sessionId.prefix(8))].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1).textSelection(.enabled)
            }
            CmuxSessionPanel(
                sessionId: session.target.sessionId,
                window: nil, workspace: nil, pane: nil, surface: nil,
                tree: tree, loading: loading, busy: busy, lastPane: nil,
                choosing: $choosing, notice: $notice,
                modeKey: "widget.cmux.pickerMode",
                focus: { Task { await perform(focus) } },
                open: { target in Task { await perform { await open(at: target) } } },
                reload: load)
        }
        .task { load() }
    }

    private func load() {
        guard !loading else { return }
        loading = true
        Task {
            // Not the exit status: with cmux unreachable the command prints {available: false, error} and exits 1.
            let result = try? await model.bridge.run(subcommand: "ai", args: ["cmux", "tree", "--json"], timeoutSeconds: 20)
            tree = result.flatMap { try? CmuxTree.decode(Data($0.stdout.utf8)) }
            loading = false
        }
    }

    private func focus() async -> String? {
        let tool = CmuxCommandRunner.tool(provider: session.target.provider)
        do {
            let result = try await model.bridge.run(
                subcommand: tool, args: ["cmux", "focus", session.target.sessionId, "--first", "--json"], timeoutSeconds: 30)
            return CmuxCommandRunner.focusFailure(
                status: result.exitCode, stdout: Data(result.stdout.utf8), stderr: Data(result.stderr.utf8))
        } catch {
            return error.localizedDescription
        }
    }

    /// Claude resumes through `tools claude cmux open-session`; another agent's resume command is typed into the pane.
    private func open(at target: CmuxTarget) async -> String? {
        let sessionId = session.target.sessionId
        if session.target.provider == "claude",
           let args = target.openSessionArgs ?? tree?.windows.first.map({ ["--window", $0.target] }) {
            do {
                let result = try await model.bridge.run(
                    subcommand: "claude", args: ["cmux", "open-session", sessionId] + args + ["--json"], timeoutSeconds: 60)
                return CmuxCommandRunner.openSessionFailure(
                    status: result.exitCode, stdout: Data(result.stdout.utf8), stderr: Data(result.stderr.utf8))
            } catch {
                return error.localizedDescription
            }
        }
        guard let command = CmuxCommandRunner.resumeCommand(provider: session.target.provider, sessionId: sessionId) else {
            return "No resume command for \(session.target.provider)"
        }
        let cwd = session.target.cwd
        let name = session.title
        return await Task.detached(priority: .userInitiated) {
            CmuxCommandRunner.run(command, cwd: cwd, name: name, at: target)
        }.value
    }

    private func perform(_ action: @escaping () async -> String?) async {
        busy = true
        let error = await action()
        busy = false
        if error == CmuxCommandRunner.paneGone {
            // The tab it ran in is closed: say so in words and show where it can go instead.
            notice = CmuxSessionPanel.Notice(text: error ?? "", isError: true)
            choosing = true
        } else {
            notice = CmuxSessionPanel.Notice(text: error.map { "cmux: \($0)" } ?? "Done", isError: error != nil)
        }
        load()
    }
}
