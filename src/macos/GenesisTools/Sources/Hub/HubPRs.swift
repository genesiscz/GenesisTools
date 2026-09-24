import AppKit
import SwiftUI

// Hub "PRs" mode: the GitHub PRs and GitLab MRs of every project the recent sessions worked in.
// Data comes from `tools hub pr list` / `tools hub pr show` (src/hub/lib/prs.ts); Swift only reads
// JSON. From a PR you open it on the web, see its diff (when a local worktree has the branch), the
// sessions that worked on the branch, and start or resume one there.

struct HubPR: Decodable, Identifiable, Equatable {
    struct Origin: Decodable, Equatable {
        let kind: String?
        let host: String?
        let web: String?
    }

    let repo: String
    let repoRoot: String?
    let origin: Origin?
    let number: Int
    let title: String
    let state: String
    let draft: Bool
    let author: String?
    let headBranch: String
    let baseBranch: String
    let url: String
    let createdAt: String?
    let updatedAt: String?
    let labels: [String]
    let reviewers: [String]
    let reviewDecision: String?
    let approvals: Int?
    let ci: String?
    let comments: Int?
    let headSha: String?
    let localWorktree: String?
    let isMine: Bool?

    /// The PR's web URL: unique across hosts and projects, where `repo` is only the folder's basename
    /// (`org-a/service#12` and `org-b/service#12` both read `service#12`).
    var id: String { url.isEmpty ? "\(project)#\(number)" : url }
    /// The project the PR belongs to (the same key `tools hub pr list` groups checkouts by); `repo` is
    /// only its display name.
    var project: String { origin?.web ?? repoRoot ?? repo }
    var isGitLab: Bool { origin?.kind == "gitlab" }
    var label: String { isGitLab ? "!\(number)" : "#\(number)" }
    var updated: Date? { HubFormat.date(updatedAt) }
}

struct HubPRDetail: Decodable, Equatable {
    struct Commit: Decodable, Equatable, Identifiable {
        let sha: String
        let title: String
        let author: String?
        let date: String?
        var id: String { sha }
    }

    struct Check: Decodable, Equatable, Identifiable {
        let name: String
        let status: String?
        let url: String?
        var id: String { name + (url ?? "") }
    }

    struct WebUrls: Decodable, Equatable {
        let pr: String?
        let files: String?
        let commits: String?
        let checks: String?
    }

    let body: String?
    let commits: [Commit]?
    let changedFiles: Int?
    let additions: Int?
    let deletions: Int?
    let baseSha: String?
    let mergeable: String?
    let checks: [Check]?
    let webUrls: WebUrls?
    let localWorktree: String?
}

private struct HubPRList: Decodable {
    struct Repo: Decodable {
        let repo: String
        let error: String?
    }

    let prs: [HubPR]
    let repos: [Repo]
}

@MainActor
final class PRsModel: ObservableObject {
    @Published private(set) var prs: [HubPR] = []
    @Published private(set) var errors: [String] = []
    @Published private(set) var loading = false
    @Published var selectedID: String?
    @Published private(set) var details: [String: HubPRDetail] = [:]
    @Published var review: ReviewModel?
    // Published and saved by hand: `@AppStorage` inside an ObservableObject never publishes.
    @Published var state = UserDefaults.standard.string(forKey: "hub.prs.state") ?? "open" {
        didSet { UserDefaults.standard.set(state, forKey: "hub.prs.state") }
    }
    @Published var mineOnly = UserDefaults.standard.bool(forKey: "hub.prs.mine") {
        didSet { UserDefaults.standard.set(mineOnly, forKey: "hub.prs.mine") }
    }
    /// Called once after a list load (the `--snapshot` launch waits on it).
    var onLoaded: (() -> Void)?
    private var paths: [String] = []
    /// A load asked for while one ran (the state picker changed mid-load). It runs when that one ends.
    private var reloadPending = false
    /// The worktree, PR, base and head the `review` diff was built for.
    private var reviewKey: String?

    var selected: HubPR? { prs.first { $0.id == selectedID } }

    func load(paths: [String]) {
        self.paths = paths
        guard !loading else {
            reloadPending = true
            return
        }

        loading = true
        let state = state
        // Mine asks the forge (`gh --author @me`, glab's own filter): filtering the capped list here
        // lost every authored PR past the first 40.
        let mine = mineOnly ? ["--mine"] : []
        Task {
            let span = HubPerf.begin("prs.list", "\(paths.count) projects state=\(state) mine=\(mineOnly)", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<HubPRList, Error> in
                Result {
                    let data = try ToolsCLIRunner.run(["hub", "pr", "list"] + paths + ["--state", state, "--limit", "40"] + mine)
                    return try JSONDecoder().decode(HubPRList.self, from: data)
                }
            }.value
            loading = false
            if reloadPending {
                // The result answers an older state or path set; the newer request replaces it.
                reloadPending = false
                span.end("superseded")
                load(paths: self.paths)
                return
            }

            defer {
                onLoaded?()
                onLoaded = nil
            }
            switch result {
            case .success(let list):
                span.end("\(list.prs.count) prs")
                prs = list.prs.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
                errors = list.repos.compactMap { repo in repo.error.map { "\(repo.repo): \($0)" } }
                if selectedID == nil || selected == nil, let first = prs.first(where: { $0.isMine == true }) ?? prs.first {
                    select(first)
                }
            case .failure(let error):
                span.end("failed")
                errors = ["\(error)"]
            }
        }
    }

    func reload() {
        let current = paths
        load(paths: current)
    }

    func select(_ pr: HubPR) {
        selectedID = pr.id
        if let path = pr.localWorktree {
            let head = pr.headSha ?? "HEAD"
            // Two PRs can share a worktree (stacked, or closed and reopened), so the diff is rebuilt
            // whenever the PR, its base or its head changes, not only the folder.
            let key = [path, pr.id, pr.baseBranch, head].joined(separator: "\n")
            if reviewKey != key {
                let next = ReviewModel(repo: URL(fileURLWithPath: path), options: DiffViewOptions())
                next.embedded = true
                // The PR's own base, not the branch scope's guess (which picks master for a stacked PR).
                next.scope = .range(base: "origin/\(pr.baseBranch)", head: head, label: "\(pr.label) \(pr.baseBranch)…\(pr.headBranch)")
                review = next
                reviewKey = key
            }
        } else {
            review = nil
            reviewKey = nil
        }
        guard details[pr.id] == nil, let root = pr.repoRoot else { return }
        let key = pr.id
        Task {
            let span = HubPerf.begin("prs.show", key, awaits: true)
            let detail = await Task.detached(priority: .userInitiated) { () -> HubPRDetail? in
                guard let data = try? ToolsCLIRunner.run(["hub", "pr", "show", "\(root)#\(pr.number)"]) else { return nil }
                return try? JSONDecoder().decode(HubPRDetail.self, from: data)
            }.value
            span.end(detail == nil ? "failed" : "")
            if let detail {
                details[key] = detail
            }
        }
    }
}

// MARK: - Sidebar list

struct PRListView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var prs: PRsModel
    @StateObject private var prefs = GroupPrefs(key: "prs.repos")

    /// One group per project (`HubPR.project`): two checkouts named `service` from different origins
    /// stay apart. The folder name is only the title.
    private var groups: [(project: String, repo: String, rows: [HubPR])] {
        let needle = model.filter.trimmed.lowercased()
        let rows = prs.prs.filter { pr in
            (!prs.mineOnly || pr.isMine == true)
                && (needle.isEmpty || "\(pr.repo) \(pr.label) \(pr.title) \(pr.author ?? "") \(pr.headBranch)".lowercased().contains(needle))
        }
        let grouped = Dictionary(grouping: rows, by: \.project)
        let titles = grouped.mapValues { $0.first?.repo ?? "" }
        return prefs.sorted(Array(grouped.keys), label: { titles[$0] ?? $0 }).map { ($0, titles[$0] ?? $0, grouped[$0] ?? []) }
    }

    var body: some View {
        let groups = groups
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Picker("", selection: Binding(get: { prs.state }, set: { prs.state = $0; prs.reload() })) {
                    Text("Open").tag("open")
                    Text("Merged").tag("merged")
                    Text("All").tag("all")
                }
                .pickerStyle(.segmented)
                .frame(width: 170)
                .instantTooltip("Which PRs/MRs to list")
                Toggle("Mine", isOn: Binding(get: { prs.mineOnly }, set: { prs.mineOnly = $0; prs.reload() }))
                    .toggleStyle(.checkbox)
                    .font(.system(size: 11.5))
                    .instantTooltip("Only PRs/MRs you opened")
                Spacer()
                if prs.loading {
                    ProgressView().controlSize(.small)
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Reload the PR/MR list") { prs.reload() }
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 6)
            ForEach(prs.errors, id: \.self) { error in
                NoticePill(text: error, isError: true) {}
                    .padding(.horizontal, 10)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                    ForEach(groups, id: \.project) { group in
                        Section {
                            if !prefs.collapsed.contains(group.project) {
                                ForEach(group.rows) { pr in
                                    row(pr)
                                }
                            }
                        } header: {
                            GroupHeader(
                                title: group.repo,
                                count: group.rows.count,
                                prefs: prefs,
                                allNames: groups.map(\.project),
                                path: group.rows.first?.repoRoot,
                                key: group.project
                            )
                        }
                    }
                }
                .padding(.bottom, 12)
            }
        }
    }

    private func row(_ pr: HubPR) -> some View {
        let selected = prs.selectedID == pr.id
        return Button { prs.select(pr) } label: {
            HStack(alignment: .top, spacing: 8) {
                PRStateIcon(pr: pr)
                VStack(alignment: .leading, spacing: 2) {
                    Text(pr.title)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.92))
                        .lineLimit(2)
                    HStack(spacing: 5) {
                        Text(verbatim: pr.label).font(.system(size: 11, design: .monospaced))
                        Text(verbatim: pr.author ?? "")
                        Text(verbatim: "·")
                        Text(verbatim: HubFormat.ago(pr.updated))
                    }
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 3) {
                    CIBadge(ci: pr.ci)
                    if pr.localWorktree != nil {
                        Image(systemName: "externaldrive.badge.checkmark")
                            .font(.system(size: 10))
                            .foregroundColor(ReviewPalette.dim)
                            .instantTooltip("The branch is checked out locally: diff and sessions available")
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 8))
        .instantTooltip("\(pr.label) \(pr.headBranch) → \(pr.baseBranch)")
    }
}

struct PRStateIcon: View {
    let pr: HubPR

    var body: some View {
        let (symbol, color): (String, Color) = {
            if pr.draft { return ("circle.dashed", ReviewPalette.dim) }
            switch pr.state {
            case "MERGED": return ("arrow.triangle.merge", Color(red: 0.66, green: 0.5, blue: 1))
            case "CLOSED": return ("xmark.circle", ReviewPalette.removed)
            default: return ("arrow.triangle.pull", ReviewPalette.added)
            }
        }()
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(color)
            .frame(width: 16)
            .instantTooltip(pr.draft ? "Draft" : pr.state.capitalized)
    }
}

struct CIBadge: View {
    let ci: String?

    var body: some View {
        if let ci {
            let (symbol, color): (String, Color) = {
                switch ci {
                case "success": return ("checkmark.circle.fill", ReviewPalette.added)
                case "failed": return ("xmark.octagon.fill", ReviewPalette.removed)
                case "running": return ("circle.dotted", ReviewPalette.modified)
                default: return ("clock", ReviewPalette.dim)
                }
            }()
            Image(systemName: symbol)
                .font(.system(size: 11))
                .foregroundColor(color)
                .instantTooltip("CI: \(ci)")
        }
    }
}

/// The main area in PRs mode; observes `PRsModel` so a selection redraws it.
struct PRsMain: View {
    @ObservedObject var model: HubModel
    @ObservedObject var prs: PRsModel

    var body: some View {
        if let pr = prs.selected {
            PRDetailView(model: model, prs: prs, pr: pr)
                .id(pr.id)
        } else {
            Text(prs.loading ? "Loading PRs and MRs…" : "Pick a PR or MR")
                .foregroundColor(ReviewPalette.dim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Detail

struct PRDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var prs: PRsModel
    let pr: HubPR
    @AppStorage("hub.prs.showDiff") private var showDiff = true
    @State private var launching = false
    @State private var resuming: HubSession?

    private var detail: HubPRDetail? { prs.details[pr.id] }

    /// Sessions that worked on the PR's branch: by the branch the transcript recorded, or by folder.
    private var sessions: [HubSession] {
        model.sessions.filter { session in
            session.gitBranch == pr.headBranch || (pr.localWorktree.map { session.cwd == $0 || session.cwd.hasPrefix($0 + "/") } ?? false) && session.gitBranch == nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if showDiff, let review = prs.review {
                HSplitView {
                    overview.frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                    ReviewRootView(model: review).frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                overview
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                PRStateIcon(pr: pr)
                Text(pr.title)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                ExternalLink(text: pr.label, url: URL(string: pr.url), font: .system(size: 13, weight: .semibold), color: Color(red: 0.62, green: 0.78, blue: 1))
                CIBadge(ci: pr.ci)
                Spacer()
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.contains("failed") || notice.hasPrefix("cmux:")) { model.notice = nil }
                }
                if prs.review != nil {
                    Toggle("Diff", isOn: $showDiff)
                        .toggleStyle(.button)
                        .instantTooltip("Show the branch diff beside the PR")
                }
                if let path = pr.localWorktree {
                    Button {
                        launching = true
                    } label: {
                        Label("New session here", systemImage: "plus.bubble")
                    }
                    .instantTooltip("Start Claude, Codex or Grok in the PR's worktree; pick the terminal target first")
                    .popover(isPresented: $launching, arrowEdge: .bottom) {
                        LaunchPicker(mode: .new(cwd: path, name: "\(pr.repo) \(pr.label)")) { message in
                            launching = false
                            if !message.isEmpty { model.notice = message }
                        }
                    }
                }
            }
            HStack(spacing: 10) {
                Label(pr.author ?? "unknown", systemImage: "person.crop.circle")
                Text(verbatim: "\(pr.headBranch) → \(pr.baseBranch)")
                    .font(.system(size: 11.5, design: .monospaced))
                    .textSelection(.enabled)
                if let detail {
                    if let files = detail.changedFiles {
                        Text(verbatim: "\(files) files")
                    }
                    if let add = detail.additions, let del = detail.deletions {
                        Text(verbatim: "+\(add)").foregroundColor(ReviewPalette.added)
                        Text(verbatim: "−\(del)").foregroundColor(ReviewPalette.removed)
                    }
                    if let mergeable = detail.mergeable {
                        Text(mergeable).foregroundColor(mergeable == "conflicting" ? ReviewPalette.removed : ReviewPalette.dim)
                    }
                }
                if let approvals = pr.approvals, approvals > 0 {
                    Label("\(approvals)", systemImage: "hand.thumbsup").instantTooltip("\(approvals) approvals")
                }
                ForEach(pr.labels, id: \.self) { label in
                    Text(label)
                        .font(.system(size: 10.5))
                        .padding(.horizontal, 6)
                        .background(Capsule().fill(Color.white.opacity(0.08)))
                }
                if let path = pr.localWorktree {
                    PathLabel(path: path)
                }
                Spacer()
                if let web = detail?.webUrls {
                    if let files = web.files { ExternalLink(text: "Files", url: URL(string: files)) }
                    if let commits = web.commits { ExternalLink(text: "Commits", url: URL(string: commits)) }
                    if let checks = web.checks { ExternalLink(text: "Checks", url: URL(string: checks)) }
                }
            }
            .font(.system(size: 11.5))
            .foregroundColor(ReviewPalette.dim)
        }
        .padding(.leading, 18)
        .padding(.trailing, 14)
        .padding(.top, 34)
        .padding(.bottom, 10)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
    }

    private var overview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                sessionsSection
                if let body = detail?.body?.trimmed, !body.isEmpty {
                    section("Description") {
                        MarkdownContentView(markdown: body)
                    }
                } else if detail == nil {
                    ProgressView().controlSize(.small)
                }
                if let commits = detail?.commits, !commits.isEmpty {
                    section("Commits \(commits.count)") {
                        ForEach(commits) { commit in
                            HStack(spacing: 8) {
                                Button { PathOpener.copy(commit.sha) } label: {
                                    Text(verbatim: String(commit.sha.prefix(8))).font(.system(size: 11, design: .monospaced))
                                }
                                .buttonStyle(.genHoverPlain())
                                .instantTooltip("Copy \(commit.sha)")
                                Text(commit.title).font(.system(size: 12)).lineLimit(1)
                                Spacer()
                                Text(commit.author ?? "").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                            }
                        }
                    }
                }
                if let checks = detail?.checks, !checks.isEmpty {
                    section("Checks") {
                        ForEach(checks) { check in
                            HStack(spacing: 8) {
                                CIBadge(ci: check.status)
                                ExternalLink(text: check.name, url: check.url.flatMap(URL.init(string:)))
                                Spacer()
                            }
                        }
                    }
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sessionsSection: some View {
        section("Sessions on \(pr.headBranch) \(sessions.count)") {
            if sessions.isEmpty {
                Text(pr.localWorktree == nil ? "No local worktree has this branch, and no session recorded it." : "No session worked on this branch yet.")
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
            }
            ForEach(sessions) { session in
                HStack(spacing: 8) {
                    Text(verbatim: String(session.provider.prefix(1)).uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 16, height: 16)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.1)))
                    Text(session.displayTitle).font(.system(size: 12)).lineLimit(1)
                    Text(HubFormat.ago(session.lastActivity)).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    Spacer()
                    Button("Open") { model.openSession(session) }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip("Show this session in the hub")
                    Button("Resume") { resuming = session }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip("Resume it in a terminal pane you pick")
                }
            }
        }
        .popover(item: $resuming) { session in
            LaunchPicker(mode: .resume(session)) { message in
                resuming = nil
                if !message.isEmpty { model.notice = message }
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
            content()
        }
    }
}
