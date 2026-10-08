import AppKit
import SwiftUI

// Where the review window's comments go. A comment reads "Sent to <session>" only after that session's
// pane got the one line naming the outbox file; with nobody to send to it is "Queued" (written, nobody
// told). A window opened for a session sends there; any other window picks one of the sessions that
// worked on the PR's branch (`tools hub pr sessions`) in "Send N…", and that pick is kept per PR.

/// One session to send comments to.
struct AgentTarget: Equatable, Codable {
    let sessionId: String
    /// `claude`, `codex`, `grok`: picks the cmux resolver (`cmuxTool`); nil goes through Claude's.
    let provider: String?
    /// What the card says it went to: the session's title, else its short id.
    let name: String

    /// A session id the terminal host can be handed (no spaces, no shell syntax).
    static func validID(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9-]+$", options: .regularExpression) != nil
    }

    static func key(_ scope: String) -> String { "review.agentTarget.\(scope)" }

    static func remembered(for scope: String, in defaults: UserDefaults = HubDefaults.store) -> AgentTarget? {
        guard let data = defaults.data(forKey: key(scope)), let target = try? JSONDecoder().decode(AgentTarget.self, from: data),
              validID(target.sessionId) else { return nil }
        return target
    }

    func remember(for scope: String, in defaults: UserDefaults = HubDefaults.store) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(scope))
    }
}

/// What one send did, and what the review window then says.
enum AgentDelivery: Equatable {
    /// The pane got the line: the comments read "Sent to <name>".
    case sent(to: String)
    /// Written to the outbox, nobody told.
    case queued

    static func outcome(target: AgentTarget?, error: String?) -> AgentDelivery {
        guard let target, error == nil else { return .queued }
        return .sent(to: target.name)
    }

    static func notice(_ outcome: AgentDelivery, count: Int, host: String, error: String?) -> String {
        let what = count == 1 ? "1 comment" : "\(count) comments"
        switch outcome {
        case .sent(let to):
            return "Sent \(what) to \(to)."
        case .queued:
            if let error {
                return "\(host) send failed (\(error.prefix(80))): \(what) queued, not sent."
            }
            return "Queued \(what), not sent."
        }
    }
}

/// One comment in the "Send N…" list.
struct AgentSendItem: Identifiable, Equatable {
    let id: String
    let path: String
    let startLine: Int
    let endLine: Int
    /// The PR thread it answers, when it is a reply.
    let thread: String?
    let body: String
    let state: String

    var lines: String { startLine == endLine ? "L\(startLine)" : "L\(startLine)–\(endLine)" }
    /// "jest.config.js:L51–53", or "Reply to thread 28bdd247 · jest.config.js:L51–53".
    var place: String {
        let at = "\((path as NSString).lastPathComponent):\(lines)"
        return thread.map { "Reply to thread \($0.prefix(8)) · \(at)" } ?? at
    }
}

/// Which of the listed comments a send takes: all of them, minus the ones unticked. A comment that left
/// the list (removed, deleted, sent) leaves the unticked set too, so a later one with its place is ticked.
enum AgentSendPlan {
    static func ids(_ items: [AgentSendItem], unticked: Set<String>) -> [String] {
        items.map(\.id).filter { !unticked.contains($0) }
    }

    static func pruned(_ unticked: Set<String>, to items: [AgentSendItem]) -> Set<String> {
        unticked.intersection(items.map(\.id))
    }

    static func sendTitle(_ count: Int) -> String {
        count == 0 ? "Send" : "Send \(count)"
    }
}

/// The header's "Send N…": every comment it will send (tick to keep in this send, edit in place, take
/// out of the send, delete), the message the agent gets behind "Preview message", then the PR's sessions
/// (the window's own first, the one picked last time for this PR preselected), Send, and the honest
/// fallback "Copy, not sent".
struct AgentSendForm: View {
    @ObservedObject var model: ReviewModel
    var previewOpen = false
    let close: () -> Void
    @State private var sessions: [HubPRSessionMatch] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var choice: String?
    @State private var unticked: Set<String> = []
    @State private var editing: String?
    @State private var editText = ""
    @State private var showsPreview: Bool?

    private var items: [AgentSendItem] { model.pendingAgentItems }
    private var chosen: [String] { AgentSendPlan.ids(items, unticked: unticked) }

    var body: some View {
        let items = items
        let chosen = chosen
        VStack(alignment: .leading, spacing: 10) {
            Text("Send \(chosen.count) of \(items.count) \(items.count == 1 ? "comment" : "comments") to an agent")
                .font(.system(size: 13, weight: .semibold))
            Text("The agent's pane gets one line naming a file with every ticked comment and its code. They say Sent only once that pane got it.")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            commentList(items)
            preview(chosen)
            Text("Send to").font(.system(size: 11, weight: .semibold)).foregroundColor(ReviewPalette.dim)
            sessionList
            HStack(spacing: 8) {
                Button("Copy, not sent") {
                    model.copyForAgent(ids: chosen)
                    close()
                }
                .disabled(chosen.isEmpty)
                .instantTooltip("Copy the ticked comments with their code to the clipboard. They stay queued: nothing is sent.")
                Spacer()
                Button("Cancel", action: close)
                    .keyboardShortcut(.cancelAction)
                Button(AgentSendPlan.sendTitle(chosen.count)) { send(chosen) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(choice == nil || chosen.isEmpty || editing != nil)
                    .instantTooltip(editing != nil ? "Save or cancel the edit first"
                        : "Type one line naming the ticked comments' file into that session's cmux pane; this pick is kept for the PR")
            }
            .buttonStyle(.genHoverPlain())
        }
        .padding(14)
        .frame(width: 520)
        .task { await load() }
        .onChange(of: items) { _, now in unticked = AgentSendPlan.pruned(unticked, to: now) }
    }

    // MARK: Comments

    @ViewBuilder
    private func commentList(_ items: [AgentSendItem]) -> some View {
        if items.isEmpty {
            Text("No comments are waiting for an agent.")
                .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(items) { item in
                        commentRow(item)
                    }
                }
            }
            .frame(maxHeight: 260)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func commentRow(_ item: AgentSendItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Toggle("", isOn: Binding(
                get: { !unticked.contains(item.id) },
                set: { on in
                    if on {
                        unticked.remove(item.id)
                    } else {
                        unticked.insert(item.id)
                    }
                }
            ))
            .toggleStyle(.checkbox)
            .labelsHidden()
            .instantTooltip("Send this comment with the others; unticked, it waits for a later send")
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: "\((item.path as NSString).lastPathComponent):\(item.lines)")
                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                        .foregroundColor(ReviewPalette.renamed)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .instantTooltip("\(item.path):\(item.lines)")
                    if let thread = item.thread {
                        Badge("reply · \(thread.prefix(8))", color: ReviewPalette.modified, look: .tone,
                              tooltip: "It answers the PR thread \(thread) on these lines")
                    }
                    Badge(item.state == "queued" ? "Queued" : "Local", look: .tag)
                    Spacer(minLength: 4)
                    if editing != item.id {
                        Button("Edit") {
                            editText = item.body
                            editing = item.id
                        }
                        .instantTooltip("Change the comment's text here; the card in the diff changes with it")
                        Button("Remove") {
                            model.holdFromAgent(item.id)
                        }
                        .instantTooltip("Take it out of this send. It stays as your local comment; Queue to agent on its card puts it back")
                        Button("Delete") {
                            model.deleteComment(item.id)
                        }
                        .instantTooltip("Delete the comment")
                    }
                }
                .font(.system(size: 11.5))
                .buttonStyle(.genHoverPlain())
                if editing == item.id {
                    TextEditor(text: $editText)
                        .font(.system(size: 12))
                        .scrollContentBackground(.hidden)
                        .frame(height: 80)
                        .padding(4)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.25)))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.15)))
                    HStack(spacing: 8) {
                        Spacer()
                        Button("Cancel") { editing = nil }
                        Button("Save") {
                            model.editComment(item.id, body: editText.trimmed)
                            editing = nil
                        }
                        .disabled(editText.trimmed.isEmpty)
                        .instantTooltip("The same save as the card's Edit")
                    }
                    .font(.system(size: 11.5))
                    .buttonStyle(.genHoverPlain())
                } else {
                    Text(verbatim: item.body)
                        .font(.system(size: 12))
                        .foregroundColor(Color.white.opacity(unticked.contains(item.id) ? 0.45 : 0.85))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.035)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(ReviewPalette.hairline))
    }

    // MARK: Preview

    @ViewBuilder
    private func preview(_ chosen: [String]) -> some View {
        let open = Binding(get: { showsPreview ?? previewOpen }, set: { showsPreview = $0 })
        DisclosureGroup(isExpanded: open) {
            // Built only while open: the message reads every chosen comment's code.
            if open.wrappedValue {
                ScrollView {
                    Text(verbatim: chosen.isEmpty ? "Nothing ticked." : model.agentMessage(ids: chosen))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Color.white.opacity(0.8))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(height: 180)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.3)))
            }
        } label: {
            Text("Preview message").font(.system(size: 11.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
        }
        .instantTooltip("The markdown file the agent reads: each ticked comment with the code it points at")
    }

    // MARK: Sessions

    @ViewBuilder
    private var sessionList: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let own = model.session, AgentTarget.validID(own) {
                row(id: own) {
                    Image(systemName: "macwindow").font(.system(size: 11)).frame(width: 16)
                    Text("This window's session \(own.prefix(8))").font(.system(size: 12))
                    Spacer(minLength: 4)
                }
            }
            if loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Looking for the sessions on \(model.pr?.payload?.pr.sourceBranch ?? model.branch)…")
                        .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
            }
            if let loadError {
                Text(verbatim: loadError).font(.system(size: 11.5)).foregroundColor(ReviewPalette.removed).lineLimit(3)
            }
            ForEach(sessions) { session in
                row(id: session.sessionId) {
                    ProviderBadge(provider: session.provider, size: 16, tooltip: session.provider.capitalized)
                    Text(verbatim: Self.title(session)).font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
                    LiveAgo(date: HubFormat.date(session.mtime)).font(.system(size: 11)).foregroundColor(ReviewPalette.dim).fixedSize()
                    Text(verbatim: session.reasons.joined(separator: " · ")).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                    Spacer(minLength: 4)
                }
            }
            if !loading, sessions.isEmpty, loadError == nil, model.session == nil {
                Text("No session worked on this branch. Copy the comments and paste them into an agent.")
                    .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    static func title(_ session: HubPRSessionMatch) -> String {
        if let title = session.title, !title.isEmpty {
            return title
        }
        return String(session.sessionId.prefix(8))
    }

    private func row<Content: View>(id: String, @ViewBuilder content: () -> Content) -> some View {
        Button { choice = id } label: {
            HStack(spacing: 7) {
                Image(systemName: choice == id ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 12))
                    .foregroundColor(choice == id ? ReviewPalette.renamed : ReviewPalette.dim)
                content()
            }
            .padding(.horizontal, 6)
            .frame(height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow())
    }

    private func send(_ ids: [String]) {
        guard let choice else { return }
        let target: AgentTarget
        if let session = sessions.first(where: { $0.sessionId == choice }) {
            target = AgentTarget(sessionId: session.sessionId, provider: session.provider, name: Self.title(session))
        } else if let remembered = AgentTarget.remembered(for: model.agentTargetKey), remembered.sessionId == choice {
            // Not listed this time: keep the saved provider, or a Codex or Grok session goes through Claude's path.
            target = remembered
        } else {
            target = AgentTarget(sessionId: choice, provider: nil, name: "session \(choice.prefix(8))")
        }
        target.remember(for: model.agentTargetKey)
        model.sendToAgent(ids: ids, to: target)
        close()
    }

    private func load() async {
        let remembered = AgentTarget.remembered(for: model.agentTargetKey)
        choice = model.session.flatMap { AgentTarget.validID($0) ? $0 : nil } ?? remembered?.sessionId
        let info = model.pr?.payload?.pr
        var args = ["hub", "pr", "sessions", "--repo", model.repo.path, "--branch", info?.sourceBranch ?? model.branch, "--json", "--max-cache-age", "60"]
        if let base = info?.baseSha, let head = info?.headSha {
            args += ["--base", base, "--head", head]
        }
        let span = HubPerf.begin("review.agentSend.sessions", args.suffix(from: 3).prefix(4).joined(separator: " "), awaits: true)
        let result = await Task.detached(priority: .userInitiated) {
            Result { try JSONDecoder().decode(HubPRSessions.self, from: ToolsCLIRunner.run(args)) }
        }.value
        loading = false
        switch result {
        case .success(let found):
            span.end("\(found.sessions.count) sessions")
            sessions = found.sessions.filter { AgentTarget.validID($0.sessionId) }
            if choice == nil {
                choice = sessions.first?.sessionId
            }
        case .failure(let error):
            span.end("failed")
            loadError = "The sessions did not load: \(error)"
        }
    }
}
