import AppKit
import SwiftUI

// The handoff composer: pick the last N prompts or a range, preview the markdown that
// `tools hub handoff <id> --json` builds from the transcript alone (no model call), then copy it, save
// it into a folder, or post it to the handoff store (`--post --owner`, the handoff_post store the
// dev-dashboard and agents read). Every write goes through the CLI, so a terminal can do the same.

/// A composer asked for from outside the sidebar (`tools hub --handoff`): "" means the selected
/// session, anything else a session id prefix. The sidebar that shows that session opens it and clears it.
@MainActor
final class HubHandoffRequests: ObservableObject {
    static let shared = HubHandoffRequests()
    @Published var pending: String?

    func claim(_ sessionId: String) -> Bool {
        guard let pending, pending.isEmpty || sessionId.hasPrefix(pending) else { return false }
        self.pending = nil
        return true
    }
}

struct HandoffComposerRequest: Identifiable {
    let id = UUID()
    let session: HubSession
    /// Prompts of the session, from its insights; empty until they load (the range picker then waits).
    let prompts: [InsightTurn]
    /// Open on a range starting at this "#N"; nil opens on the last prompts.
    let from: Int?
    /// The session's branch, read on the main thread when the composer opens (a HEAD file read).
    let branch: String?

    @MainActor
    init(session: HubSession, prompts: [InsightTurn], from: Int?) {
        self.session = session
        self.prompts = prompts
        self.from = from
        branch = HubSessionDetailHost.branch(of: session)
    }
}

enum HandoffRangeChoice: Equatable {
    case last(Int)
    case range(from: Int, to: Int)

    var arguments: [String] {
        switch self {
        case .last(let count): return ["--last", String(count)]
        case .range(let from, let to): return ["--from", String(min(from, to)), "--to", String(max(from, to))]
        }
    }
}

struct HandoffDraftPayload: Decodable, Equatable {
    struct Posted: Decodable, Equatable {
        let id: String
        let name: String?
        let paste: String
    }

    let title: String
    let markdown: String
    let fromNumber: Int
    let toNumber: Int
    let promptCount: Int
    let openItems: [String]
    let savedTo: String?
    let posted: Posted?
}

enum HubHandoff {
    /// `tools hub handoff` for this session and range. Free text rides as `--flag=value`, so a title
    /// that starts with `-` is still a value.
    static func arguments(session: HubSession, branch: String?, range: HandoffRangeChoice, extra: [String] = []) -> [String] {
        var args = ["hub", "handoff", session.sessionId, "--json"] + range.arguments
        args.append("--title=\(session.displayTitle)")
        if !session.cwd.isEmpty { args.append("--cwd=\(session.cwd)") }
        if let branch, !branch.isEmpty { args.append("--branch=\(branch)") }
        if let account = session.account, !account.isEmpty { args.append("--account=\(account)") }
        return args + extra
    }

    static func decode(_ data: Data) throws -> HandoffDraftPayload {
        try JSONDecoder().decode(HandoffDraftPayload.self, from: MonitorJSON.dataByDroppingPreamble(data))
    }

    /// Blocking: a full transcript read, seconds for a large session. Off the main thread.
    static func run(_ request: HandoffComposerRequest, range: HandoffRangeChoice, extra: [String] = []) throws -> HandoffDraftPayload {
        try decode(ToolsCLIRunner.run(arguments(session: request.session, branch: request.branch, range: range, extra: extra)))
    }
}

/// The sidebar's last row: open the composer, and the stuck thresholds beside it.
struct HandoffSidebarRow: View {
    let thresholds: StuckThresholds?
    let onCompose: () -> Void
    @ObservedObject private var stuck = HubStuckStore.shared
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SessionSectionTitle(title: "Handoff")
            Button(action: onCompose) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10.5))
                    Text("Compose a handoff…")
                        .font(.system(size: 11.5, weight: .medium))
                }
                .foregroundStyle(SessionPalette.secondary)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.12)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("A markdown brief of the last prompts or a range (goal, what happened, files, open items), to copy, save or post")
            .accessibilityIdentifier("session-details-handoff")
            StuckThresholdsMenu(thresholds: stuck.thresholds ?? thresholds) { minutes, repeats in
                Task { notice = await stuck.save(toolMinutes: minutes, repeats: repeats) }
            }
            if let notice {
                Text(verbatim: notice)
                    .font(.system(size: 11))
                    .foregroundStyle(SessionPalette.red)
                    .textSelection(.enabled)
            }
        }
    }
}

struct HandoffComposerSheet: View {
    let request: HandoffComposerRequest
    let onClose: () -> Void

    private enum Mode: String, Hashable {
        case last, range
    }

    @State private var mode: Mode
    @State private var lastCount = 5
    @State private var from: Int
    @State private var to: Int
    @State private var draft: HandoffDraftPayload?
    @State private var error: String?
    @State private var loading = false
    @State private var busy = false
    @State private var notice: String?
    @State private var noticeIsError = false
    @State private var confirmingPost = false

    init(request: HandoffComposerRequest, onClose: @escaping () -> Void) {
        self.request = request
        self.onClose = onClose
        let numbers = request.prompts.map(\.number)
        let last = numbers.last ?? 1
        _mode = State(initialValue: request.from == nil || numbers.isEmpty ? .last : .range)
        _from = State(initialValue: request.from ?? numbers.first ?? 1)
        _to = State(initialValue: last)
    }

    private var range: HandoffRangeChoice {
        mode == .last ? .last(lastCount) : .range(from: from, to: to)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
            controls
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
            preview
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
            footer
        }
        .frame(width: 680, height: 580)
        .background(SessionPalette.background)
        .environment(\.colorScheme, .dark)
        .task(id: range) {
            // One read per pause in the stepper, not per click.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await loadPreview()
        }
        .alert("Post this handoff?", isPresented: $confirmingPost) {
            Button("Post") { Task { await post() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It goes to the handoff store (handoff_post) as \"\(draft?.title ?? "")\", with \(max(1, draft?.openItems.count ?? 0)) task(s). Agents and the dev-dashboard can see and claim it.")
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch")
                .foregroundStyle(SessionPalette.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Compose a handoff")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SessionPalette.text)
                Text(verbatim: request.session.displayTitle)
                    .font(.system(size: 11))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            IconButton(systemName: "xmark", tooltip: "Close (Esc)", action: onClose)
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16)
        .frame(height: 50)
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Picker("", selection: $mode) {
                Text("Last prompts").tag(Mode.last)
                Text("Range").tag(Mode.range)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .disabled(request.prompts.isEmpty && mode == .last)
            .instantTooltip(request.prompts.isEmpty ? "The range needs the session's prompts, which have not loaded" : "The last N prompts, or a range of them")
            if mode == .last {
                Stepper(value: $lastCount, in: 1...max(1, request.prompts.isEmpty ? 50 : request.prompts.count)) {
                    Text(verbatim: "\(lastCount) prompt\(lastCount == 1 ? "" : "s")")
                        .font(SessionPalette.mono(11.5))
                        .foregroundStyle(SessionPalette.secondary)
                }
                .fixedSize()
            } else {
                promptMenu(title: "From", value: from) { from = $0 }
                promptMenu(title: "to", value: to) { to = $0 }
            }
            Spacer(minLength: 8)
            if loading {
                ProgressView().controlSize(.small)
            }
            if let draft {
                Text(verbatim: draft.promptCount > 0 ? "#\(draft.fromNumber)–#\(draft.toNumber) · \(draft.openItems.count) open" : "")
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.dim)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
    }

    private func promptMenu(title: String, value: Int, set: @escaping (Int) -> Void) -> some View {
        let label = request.prompts.first { $0.number == value }.map(\.title) ?? "#\(value)"
        return MenuButton {
            request.prompts.reversed().map { turn in
                .action(turn.title, checked: turn.number == value) { set(turn.number) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(verbatim: title)
                    .foregroundStyle(SessionPalette.faint)
                Text(verbatim: label)
                    .foregroundStyle(SessionPalette.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.down")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(SessionPalette.dim)
            }
            .font(.system(size: 11.5))
            .padding(.horizontal, 8)
            .frame(maxWidth: 210, minHeight: 24)
            .overlay(Capsule().strokeBorder(SessionPalette.cardBorder))
        }
        .instantTooltip("\(title == "to" ? "Last" : "First") prompt of the handoff, by its # in the transcript")
    }

    @ViewBuilder
    private var preview: some View {
        if let error, draft == nil {
            Text(verbatim: error)
                .font(SessionPalette.mono(11.5))
                .foregroundStyle(SessionPalette.red)
                .textSelection(.enabled)
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else if let draft {
            ScrollView {
                Text(verbatim: draft.markdown)
                    .font(SessionPalette.mono(11.5))
                    .foregroundStyle(SessionPalette.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(16)
            }
            .opacity(loading ? 0.6 : 1)
        } else {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reading the transcript…")
                    .font(.system(size: 12))
                    .foregroundStyle(SessionPalette.dim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let notice {
                NoticePill(text: notice, isError: noticeIsError) { self.notice = nil }
            }
            Spacer(minLength: 8)
            action("Copy", symbol: "doc.on.doc", tip: "Copy the markdown") {
                guard let draft else { return }
                PathOpener.copy(draft.markdown, what: "handoff")
            }
            action("Save…", symbol: "square.and.arrow.down", tip: "Write handoff-<id>-p<from>-<to>.md into a folder you choose") {
                chooseFolder()
            }
            action("Post handoff…", symbol: "paperplane", tip: "Post it to the handoff store; each open item becomes a task") {
                confirmingPost = true
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 50)
    }

    private func action(_ title: String, symbol: String, tip: String, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 10.5))
                Text(verbatim: title)
                    .font(.system(size: 11.5, weight: .medium))
            }
            .foregroundStyle(SessionPalette.secondary)
            .padding(.horizontal, 10)
            .frame(height: 28)
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.12)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(draft == nil || busy)
        .instantTooltip(tip)
    }

    // MARK: work

    private func loadPreview() async {
        let request = self.request
        let wanted = range
        loading = true
        let span = HubPerf.begin("handoff.preview", String(request.session.sessionId.prefix(8)), awaits: true)
        let result = await Task.detached(priority: .userInitiated) { Result { try HubHandoff.run(request, range: wanted) } }.value
        guard wanted == range else {
            span.end("superseded")
            return
        }

        loading = false
        switch result {
        case .success(let fresh):
            span.end("\(fresh.promptCount) prompts, \(fresh.openItems.count) open")
            draft = fresh
            error = nil
        case .failure(let failure):
            span.end("failed")
            error = failure.localizedDescription
            if draft != nil {
                show(failure.localizedDescription, error: true)
            }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Save here"
        panel.message = "Choose the folder for the handoff markdown"
        if let last = HubDefaults.store.string(forKey: "hub.handoff.folder") {
            panel.directoryURL = URL(fileURLWithPath: last)
        } else if !request.session.cwd.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: request.session.cwd)
        }
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            HubDefaults.store.set(url.path, forKey: "hub.handoff.folder")
            Task { await write(extra: ["--out=\(url.path)"]) }
        }
    }

    private func post() async {
        await write(extra: ["--post", "--owner"])
    }

    /// A save or a post: the same read as the preview, with the write flags.
    private func write(extra: [String]) async {
        let request = self.request
        let wanted = range
        busy = true
        defer { busy = false }
        let span = HubPerf.begin("handoff.write", extra.joined(separator: " "), awaits: true)
        let result = await Task.detached(priority: .userInitiated) { Result { try HubHandoff.run(request, range: wanted, extra: extra) } }.value
        switch result {
        case .success(let written):
            span.end()
            draft = written
            if let posted = written.posted {
                PathOpener.copy(posted.paste, what: "handoff paste text")
                show("Posted \(posted.name ?? posted.id); its paste text is on the clipboard", error: false)
            } else if let path = written.savedTo {
                show("Saved \((path as NSString).abbreviatingWithTildeInPath)", error: false)
            }
        case .failure(let failure):
            span.end("failed")
            show(failure.localizedDescription, error: true)
        }
    }

    private func show(_ text: String, error: Bool) {
        notice = text
        noticeIsError = error
    }
}
