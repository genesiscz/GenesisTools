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

/// The header's "Send N…": the PR's sessions (the window's own first), the one picked last time for
/// this PR preselected, Send, and the honest fallback "Copy, not sent".
struct AgentSendForm: View {
    @ObservedObject var model: ReviewModel
    let close: () -> Void
    @State private var sessions: [HubPRSessionMatch] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var choice: String?

    private var count: Int { model.pendingAgentIDs.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Send \(count) \(count == 1 ? "comment" : "comments") to an agent")
                .font(.system(size: 13, weight: .semibold))
            Text("The agent's pane gets one line naming a file with every comment and its code. The comments say Sent only once that pane got it.")
                .font(.system(size: 11.5))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
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
            HStack(spacing: 8) {
                Button("Copy, not sent") {
                    model.copyForAgent(ids: model.pendingAgentIDs)
                    close()
                }
                .instantTooltip("Copy the comments with their code to the clipboard. They stay queued: nothing is sent.")
                Spacer()
                Button("Cancel", action: close)
                    .keyboardShortcut(.cancelAction)
                Button("Send") { send() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(choice == nil || count == 0)
                    .instantTooltip("Type one line naming the comments' file into that session's cmux pane; this pick is kept for the PR")
            }
            .buttonStyle(.genHoverPlain())
        }
        .padding(14)
        .frame(width: 440)
        .task { await load() }
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

    private func send() {
        guard let choice else { return }
        let target: AgentTarget
        if let session = sessions.first(where: { $0.sessionId == choice }) {
            target = AgentTarget(sessionId: session.sessionId, provider: session.provider, name: Self.title(session))
        } else {
            target = AgentTarget(sessionId: choice, provider: nil, name: "session \(choice.prefix(8))")
        }
        target.remember(for: model.agentTargetKey)
        model.sendToAgent(ids: model.pendingAgentIDs, to: target)
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
