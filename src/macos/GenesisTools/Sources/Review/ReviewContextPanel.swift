import SwiftUI

/// The standalone review window's left panel: the branch's commits, the PR/MR's threads, and the
/// agent session's transcript, one tab at a time. It starts folded to a rail
/// (`ReviewContextPanel.collapsedKey` is registered as true), and nothing in it exists until the
/// reader opens it: `ResizableSidePanel` builds its content only while open, and only the chosen
/// tab's view is built, so the transcript's store and its `tools` calls start on the first open.
enum ReviewContextPanel {
    static let key = "review.context"
    static let collapsedKey = "panel.\(key).collapsed"

    /// Folded until the reader opens it once; from then on the saved state wins.
    static func registerDefaults() {
        HubDefaults.store.register(defaults: [collapsedKey: true])
    }

    enum Tab: String, CaseIterable, Identifiable {
        case commits, threads, session

        var id: String { rawValue }

        var title: String {
            switch self {
            case .commits: return "Commits"
            case .threads: return "Threads"
            case .session: return "Session"
            }
        }

        var tooltip: String {
            switch self {
            case .commits: return "The branch's commits: pick one to see only its changes"
            case .threads: return "Every review thread of the PR/MR, the outdated ones included"
            case .session: return "The transcript of the agent session this review is for"
            }
        }
    }

    /// The tabs this review has: threads need a PR/MR, the transcript a session.
    @MainActor
    static func tabs(model: ReviewModel) -> [Tab] {
        Tab.allCases.filter { tab in
            switch tab {
            case .commits: return true
            case .threads: return model.pr != nil
            case .session: return model.session != nil
            }
        }
    }
}

struct ReviewContextPanelView: View {
    @ObservedObject var model: ReviewModel
    @AppStorage("review.context.tab", store: HubDefaults.store) private var saved = ReviewContextPanel.Tab.threads.rawValue

    var body: some View {
        let tabs = ReviewContextPanel.tabs(model: model)
        let tab = ReviewContextPanel.Tab(rawValue: saved).flatMap { tabs.contains($0) ? $0 : nil } ?? tabs.last ?? .commits
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(tabs) { item in
                    Button {
                        saved = item.rawValue
                    } label: {
                        Text(item.title)
                            .font(.system(size: 12, weight: item == tab ? .semibold : .regular))
                            .fixedSize()
                            .foregroundColor(item == tab ? Color.white.opacity(0.92) : ReviewPalette.dim)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(item == tab ? 0.08 : 0)))
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(item.tooltip)
                    // The active tab is shown by weight and fill only; VoiceOver hears it as selected.
                    .accessibilityAddTraits(item == tab ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 44)
            .titlebarRow()
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            switch tab {
            case .commits:
                ReviewCommitsList(model: model)
            case .threads:
                if let store = model.pr {
                    PRThreadsList(model: model, store: store, compact: true)
                }
            case .session:
                if let session = model.session {
                    ReviewSessionTranscript(model: model, sessionId: session)
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .hubSurface(.chrome)
    }
}

/// The commits ahead of the base (the scope menu's "Committed" list, kept open): a row shows that
/// commit alone. "Whole branch" is the scope menu's Branch: every commit together plus what is not
/// committed yet (`DiffScope.branch` diffs the merge base against the working tree), and its row says so.
private struct ReviewCommitsList: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                row(title: "Whole branch", detail: "vs \(model.base ?? "base"), uncommitted included", selected: model.scope == .branch) {
                    model.setScope(.branch)
                }
                if model.commits.isEmpty {
                    Text("No commits ahead of the base.")
                        .font(.system(size: 12))
                        .foregroundColor(ReviewPalette.dim)
                        .padding(10)
                }
                ForEach(model.commits) { commit in
                    let selected: Bool = {
                        if case .commit(let sha, _) = model.scope { return sha == commit.sha }
                        return false
                    }()
                    row(title: commit.subject, detail: "\(commit.short) · \(commit.when)", selected: selected) {
                        model.setScope(.commit(sha: commit.sha, title: commit.subject))
                    }
                }
            }
            .padding(8)
        }
    }

    private func row(title: String, detail: String, selected: Bool, action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: title)
                .font(.system(size: 12, weight: selected ? .semibold : .regular))
                .foregroundColor(Color.white.opacity(0.9))
                .lineLimit(2)
            Text(verbatim: detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(selected ? 0.08 : 0)))
        .rowButton(cornerRadius: 6, action)
        .instantTooltip(selected ? "The diff shows this now" : "Show only these changes in the diff")
    }
}

/// The session's transcript, the hub's own screen. The session's row (provider, folder) comes from
/// `tools` on the first open. A session that list does not hold says so: its provider is unknown, and
/// a guessed one would send a Codex or Grok transcript down Claude's path.
private struct ReviewSessionTranscript: View {
    @ObservedObject var model: ReviewModel
    let sessionId: String
    @State private var session: HubSession?
    /// Why the session has no row, once the list came back without it.
    @State private var unresolved: String?

    var body: some View {
        Group {
            if let session {
                HubSessionDetailHost(session: session, onShowChange: { path, _ in
                    model.reveal(path: path)
                }, showsSidebar: false)
            } else if let unresolved {
                Text(verbatim: unresolved)
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
                    .multilineTextAlignment(.center)
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TranscriptSkeleton(turns: 2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
        .task(id: sessionId) {
            // Another session id never shows the previous session's transcript while this one loads.
            let id = sessionId
            session = nil
            unresolved = nil
            // The row found last time paints at once (ReviewCache.sessions); the list scan below still runs.
            if let cached = await Task.detached(priority: .userInitiated, operation: {
                ReviewCache.sessions.read(HubSession.self, key: id)
            }).value {
                HubPerf.log("review.context.session paint cached \(id)")
                session = cached
            }
            let span = HubPerf.begin("review.context.session", id, awaits: true)
            do {
                let rows = try await HubSource.sessions(hours: 24 * 14)
                span.end()
                if let found = rows.first(where: { $0.sessionId == id }) {
                    Task.detached(priority: .utility) { ReviewCache.sessions.write(found, key: id) }
                    if found != session {
                        session = found
                    }
                } else {
                    session = nil
                    unresolved = "Session \(id.prefix(8)) is not among the last 14 days of sessions, so its transcript cannot open here."
                }
            } catch {
                span.end()
                HubPerf.log("review.context.session list failed: \(error)")
                if session == nil {
                    unresolved = "The session list did not load: \(error.localizedDescription)"
                }
            }
        }
    }
}
