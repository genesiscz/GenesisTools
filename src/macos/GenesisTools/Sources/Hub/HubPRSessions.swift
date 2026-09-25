import Foundation
import SwiftUI

// The PR detail's "Sessions" section: every agent session that touched the PR, from
// `tools hub pr sessions` (src/hub/lib/pr-sessions.ts). It matches by the head branch's worktree, the
// branch a transcript recorded, commit and push output of the PR's commits, and change-log edits of
// the PR's files, across Claude, Codex and Grok, older than the hub's session window too.

struct HubPRSessionMatch: Decodable, Identifiable, Equatable {
    let provider: String
    let sessionId: String
    let title: String?
    let cwd: String
    let project: String?
    let gitBranch: String?
    let mtime: String
    let reasons: [String]
    let files: [String]
    let fileCount: Int
    let commits: [String]

    var id: String { sessionId }

    /// What opening it in the hub needs (the same row a history hit makes).
    var hit: HubHistoryHit {
        HubHistoryHit(kind: provider, sessionId: sessionId, title: title, cwd: cwd, project: project,
                      gitBranch: gitBranch, mtime: mtime, matchedText: nil)
    }
}

struct HubPRSessions: Decodable, Equatable {
    let sessions: [HubPRSessionMatch]
    let warnings: [String]
    let elapsedMs: Int?
    let cached: Bool?
}

@MainActor
final class PRSessionsStore: ObservableObject {
    @Published private(set) var results: [String: HubPRSessions] = [:]
    @Published private(set) var loading: Set<String> = []
    @Published private(set) var errors: [String: String] = [:]

    /// The argv for one PR, nil when the PR has no local checkout to search from.
    static func arguments(_ pr: HubPR, detail: HubPRDetail?, fresh: Bool) -> [String]? {
        guard let root = pr.repoRoot else { return nil }
        var args = ["hub", "pr", "sessions", "--repo", root, "--branch", pr.headBranch, "--json"]
        if let head = pr.headSha {
            args += ["--base", detail?.baseSha ?? "origin/\(pr.baseBranch)", "--head", head]
        }
        let shas = detail?.commits?.map(\.sha).filter { !$0.isEmpty } ?? []
        if !shas.isEmpty {
            args += ["--commits", shas.joined(separator: ",")]
        }
        // The PR's first activity: its oldest commit, else its creation.
        let dates = (detail?.commits?.compactMap { HubFormat.date($0.date) } ?? []) + [HubFormat.date(pr.createdAt)].compactMap { $0 }
        if let first = dates.min() {
            args += ["--since", HubFormat.isoPlain.string(from: first)]
        }
        if fresh {
            args.append("--no-cache")
        }
        return args
    }

    func load(_ pr: HubPR, detail: HubPRDetail?, fresh: Bool = false) {
        let key = pr.id
        guard !loading.contains(key), fresh || results[key] == nil,
              let args = Self.arguments(pr, detail: detail, fresh: fresh) else { return }
        loading.insert(key)
        Task {
            let span = HubPerf.begin("prs.sessions", key, awaits: true)
            let result = await Task.detached(priority: .utility) { () -> Result<HubPRSessions, Error> in
                Result { try JSONDecoder().decode(HubPRSessions.self, from: ToolsCLIRunner.run(args)) }
            }.value
            loading.remove(key)
            switch result {
            case .success(let found):
                span.end("\(found.sessions.count) sessions\(found.cached == true ? " cached" : "") \(found.elapsedMs ?? 0) ms")
                results[key] = found
                errors[key] = nil
            case .failure(let error):
                span.end("failed")
                errors[key] = "\(error)"
            }
        }
    }
}

/// One session row: provider, title, age, why it matched, Open and Resume.
struct PRSessionRow: View {
    @ObservedObject var model: HubModel
    let session: HubSession
    let reasons: [String]
    var files: [String] = []
    var fileCount = 0
    var commits: [String] = []
    @State private var resuming = false

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: String(session.provider.prefix(1)).uppercased())
                .font(.system(size: 10, weight: .bold))
                .frame(width: 16, height: 16)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.1)))
                .instantTooltip(session.provider.capitalized)
            FindText(session.displayTitle, field: "title").font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
            Text(verbatim: HubFormat.ago(session.lastActivity))
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize()
                .instantTooltip(session.lastActivity.map { Self.exact.string(from: $0) } ?? "")
            ForEach(reasons, id: \.self) { reason in
                reasonChip(reason)
            }
            Spacer(minLength: 4)
            Button("Open") { open() }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Show this session in the hub")
            Button("Resume") { resuming = true }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Resume it in a terminal pane you pick")
                .popover(isPresented: $resuming, arrowEdge: .bottom) {
                    LaunchPicker(mode: .resume(session)) { outcome in
                        resuming = false
                        if let notice = outcome.notice { model.notice = notice }
                    }
                }
        }
        .contextMenu {
            Button("Copy session id") { PathOpener.copy(session.sessionId) }
            Button("Copy folder") { PathOpener.copy(session.cwd) }
        }
    }

    static let exact: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        return formatter
    }()

    private func open() {
        if let known = model.sessions.first(where: { $0.sessionId == session.sessionId }) {
            model.openSession(known)
        } else {
            // Older than the list's window: a row made on the spot, as history search does.
            model.mode = .sessions
            model.openHistory(HubHistoryHit(kind: session.provider, sessionId: session.sessionId, title: session.title,
                                            cwd: session.cwd, project: session.project, gitBranch: session.gitBranch,
                                            mtime: session.lastActivity.map { HubFormat.isoPlain.string(from: $0) }, matchedText: nil))
        }
    }

    private func reasonChip(_ reason: String) -> some View {
        let (text, tip): (String, String) = {
            switch reason {
            case "worktree": return ("worktree", "Ran in a worktree of the head branch")
            case "branch": return ("branch", "Its transcript recorded the head branch")
            case "commits": return ("commits \(commits.count)", "Committed or pushed these PR commits:\n" + commits.map { String($0.prefix(9)) }.joined(separator: "\n"))
            case "files": return ("files \(fileCount)", "Edited these PR files:\n" + files.joined(separator: "\n") + (fileCount > files.count ? "\n…and \(fileCount - files.count) more" : ""))
            default: return (reason, reason)
            }
        }()
        return Text(verbatim: text)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(ReviewPalette.dim)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.white.opacity(0.07)))
            .fixedSize()
            .instantTooltip(tip)
    }
}
