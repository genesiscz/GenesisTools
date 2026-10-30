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
        args += fresh ? ["--no-cache"] : ["--max-cache-age", "60"]
        return args
    }

    /// When each PR's matches last arrived fresh in this run; the ones on screen may be the last run's.
    private var fetchedAt: [String: Date] = [:]
    /// The last answer per PR (Hub/HubSWR.swift): it shows while the fresh search runs.
    private static let cache = HubSWR.cache("pr-sessions")

    /// Opening a PR shows its last known matches and asks again, at most once a minute.
    func load(_ pr: HubPR, detail: HubPRDetail?, fresh: Bool = false) {
        let key = pr.id
        let recent = fetchedAt[key].map { Date().timeIntervalSince($0) < 60 } ?? false
        guard !loading.contains(key), fresh || !recent,
              let args = Self.arguments(pr, detail: detail, fresh: fresh) else { return }
        loading.insert(key)
        let cache = Self.cache
        Task {
            let span = HubPerf.begin("prs.sessions", key, awaits: true)
            let fetch = Task.detached(priority: .utility) { () -> Result<HubPRSessions, Error> in
                Result {
                    let data = try ToolsCLIRunner.run(args)
                    let found = try JSONDecoder().decode(HubPRSessions.self, from: data)
                    cache.writeData(data, key: key)
                    return found
                }
            }
            if results[key] == nil, let cached = await cache.load(HubPRSessions.self, key: key), results[key] == nil {
                HubSWR.painted("prs.sessions", "\(cached.sessions.count) sessions")
                withAnimation(SWR.animation) { results[key] = cached }
            }
            let result = await fetch.value
            loading.remove(key)
            switch result {
            case .success(let found):
                span.end("\(found.sessions.count) sessions\(found.cached == true ? " cached" : "") \(found.elapsedMs ?? 0) ms")
                fetchedAt[key] = Date()
                if results[key] != found {
                    withAnimation(SWR.animation) { results[key] = found }
                }
                errors[key] = nil
            case .failure(let error):
                span.end("failed")
                errors[key] = "\(error)"
            }
        }
    }
}

/// One session row: provider, title, age, why it matched, Open and Resume. A value row: the section passes the
/// session and its evidence, and opening it or the Resume outcome go back through `open` and `resumed`, so the row
/// holds no model. It is live (`liveRow`) under the pointer or while its Resume popover is up: the provider and
/// reason tooltips and the Open and Resume buttons exist only then, and at rest it draws the same labels. VoiceOver
/// still opens it (`restingButton`) and resumes it (a named action). Every control of a PR's session list was a
/// responder an accessibility client walks per update (`PRRow`).
struct PRSessionRow: View, Equatable {
    let session: HubSession
    let reasons: [String]
    var files: [String] = []
    var fileCount = 0
    var commits: [String] = []
    /// Shows the session in the hub.
    let open: () -> Void
    /// The Resume popover closed with this outcome (the hub's notice line shows it).
    let resumed: (LaunchOutcome) -> Void
    @State private var resuming = false

    static func == (a: PRSessionRow, b: PRSessionRow) -> Bool {
        a.session == b.session && a.reasons == b.reasons && a.files == b.files && a.fileCount == b.fileCount
            && a.commits == b.commits
    }

    var body: some View {
        let _ = RenderProbe.hit("prs.sessionRow.body")
        HStack(spacing: 8) {
            ProviderBadge(provider: session.provider, size: 16, tooltip: session.provider.capitalized)
            FindText(session.displayTitle, field: "title").font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
            LiveAgo(date: session.lastActivity, style: .brief)
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize()
                .instantTooltip(session.lastActivity.map { Self.exact.string(from: $0) } ?? "")
            ForEach(reasons, id: \.self) { reason in
                reasonChip(reason)
            }
            Spacer(minLength: 4)
            LiveButton(tooltip: "Show this session in the hub", pressable: true) {
                open()
            } label: {
                Text("Open")
            }
            .accessibilityAction(named: Text("Resume")) { resuming = true }
            LiveButton(tooltip: "Resume it in a terminal pane you pick") {
                resuming = true
            } label: {
                Text("Resume")
            }
            .popover(isPresented: $resuming, arrowEdge: .bottom) {
                LaunchPicker(mode: .resume(session)) { outcome in
                    resuming = false
                    resumed(outcome)
                }
            }
        }
        // The popover's anchor stays a button while it is up, with the pointer inside the popover.
        .liveRow(selected: resuming)
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
        return Badge(text, tooltip: tip)
    }
}
