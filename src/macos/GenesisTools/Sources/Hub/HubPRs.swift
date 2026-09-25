import AppKit
import SwiftUI

// Hub "PRs" mode: the GitHub PRs and GitLab MRs of every project the recent sessions worked in.
// Data comes from `tools hub pr list` / `tools hub pr show` (src/hub/lib/prs.ts); Swift only reads
// JSON. From a PR you open it on the web, see its diff (in the worktree that has the branch, else on
// the main checkout after `tools hub pr fetch`, Hub/HubPRFetch.swift), the sessions that worked on the
// branch, and start or resume one there.

struct HubPR: Decodable, Identifiable, Equatable {
    struct Origin: Decodable, Equatable {
        let kind: String?
        let host: String?
        let web: String?
    }

    /// An agent's stored review proposal for the PR (`tools hub proposal push`), matched by `tools`.
    struct Proposal: Decodable, Equatable {
        let path: String
        let decision: String
        let drafts: Int
        let pending: Int
        /// Stamped by every agent push (`tools hub proposal push`), never by a decision in the window.
        let updatedAt: String?
        let threads: Int?
        let openThreads: Int?
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
    /// The head branch lives in a fork; `headRepo` is its `owner/repo` when the host named it.
    let crossRepository: Bool?
    let headRepo: String?
    let localWorktree: String?
    let isMine: Bool?
    let proposal: Proposal?

    /// The PR's web URL: unique across hosts and projects, where `repo` is only the folder's basename
    /// (`org-a/service#12` and `org-b/service#12` both read `service#12`).
    var id: String { url.isEmpty ? "\(project)#\(number)" : url }
    /// The project the PR belongs to (the same key `tools hub pr list` groups checkouts by); `repo` is
    /// only its display name.
    var project: String { origin?.web ?? repoRoot ?? repo }
    var isGitLab: Bool { origin?.kind == "gitlab" }
    var label: String { isGitLab ? "!\(number)" : "#\(number)" }
    var updated: Date? { HubFormat.date(updatedAt) }
    /// Which stored proposal the embedded review shows. The path is fixed per PR, so a second "Review
    /// with agent" run on the same PR changes only the push stamp.
    var proposalStamp: String? { proposal.map { "\($0.path)@\($0.updatedAt ?? "")" } }
}

/// `--pr 42`, `--pr '#42'`, `--pr group/app#42`, `--pr app!12`: a PR number, optionally with the
/// project it belongs to. Numbers repeat across projects, so a bare one can be ambiguous.
struct HubPRRef: Equatable {
    let project: String?
    let number: Int

    init(project: String?, number: Int) {
        self.project = project
        self.number = number
    }

    init?(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard let split = text.lastIndex(where: { $0 == "#" || $0 == "!" }) else {
            guard let number = Int(text) else { return nil }
            project = nil
            self.number = number
            return
        }
        guard let number = Int(text[text.index(after: split)...]) else { return nil }
        let head = String(text[..<split])
        project = head.isEmpty ? nil : head
        self.number = number
    }

    /// The project matches the folder name (`app`), the web path (`group/app`) or the whole key.
    func matches(_ pr: HubPR) -> Bool {
        guard pr.number == number else { return false }
        guard let project else { return true }
        return pr.repo == project || pr.project == project || pr.project.hasSuffix("/" + project)
    }

    var label: String { project.map { "\($0)#\(number)" } ?? "#\(number)" }
}

/// A file, and optionally the PR thread on it, to open in one PR's review (Activity's "Open in the diff").
struct PRReveal: Equatable {
    let ref: HubPRRef
    let path: String
    let threadID: String?
}

struct HubPRDetail: Decodable, Equatable {
    struct Commit: Decodable, Equatable, Identifiable {
        let sha: String
        let title: String
        let author: String?
        /// The host login when the commit is linked to an account (GitHub only); `author` may be a git name.
        let authorLogin: String?
        let date: String?
        /// The message below the title line.
        let body: String?
        var id: String { sha }
        var when: Date? { HubFormat.date(date) }
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
    /// Names in the body that are branches of the local checkout (`tools hub pr show`).
    let branchMentions: [String]?
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
    /// The PR the embedded review shows. Several PRs can share one worktree, so the path alone
    /// cannot tell whether the review must be rebuilt.
    private var reviewPRID: String?
    /// The stored proposal (path and push stamp) the embedded review was built with.
    private var reviewProposalStamp: String?
    /// The head commit the embedded review diffs to; a push to the open PR moves it.
    private var reviewHeadSha: String?
    /// PRs whose branch has no local worktree: their head fetched into the main checkout, by PR id.
    @Published private(set) var fetches: [String: PRFetchEntry] = [:]
    // Published and saved by hand: `@AppStorage` inside an ObservableObject never publishes.
    @Published var state = HubDefaults.store.string(forKey: "hub.prs.state") ?? "open" {
        didSet { HubDefaults.store.set(state, forKey: "hub.prs.state") }
    }
    @Published var mineOnly = HubDefaults.store.bool(forKey: "hub.prs.mine") {
        didSet { HubDefaults.store.set(mineOnly, forKey: "hub.prs.mine") }
    }
    /// Called once after a list load (the `--snapshot` launch waits on it).
    var onLoaded: (() -> Void)?
    /// `--pr <ref>` (snapshots, links): select this PR once the list loads instead of the newest.
    var wanted: HubPRRef?
    /// A file to open in one PR's review once that review exists (`request(_:reveal:)`).
    private(set) var pendingReveal: PRReveal?
    /// Set by the command palette's "review" and cleared by the PR detail that opens "Review with
    /// agent". A flag, not a counter: the palette can switch modes, so the detail may mount after it.
    @Published var reviewRequested = false
    /// The agent sessions that touched each PR (`tools hub pr sessions`), loaded once its detail is in.
    let sessions = PRSessionsStore()
    private var paths: [String] = []
    /// A load asked for while one ran (the state picker changed mid-load). It runs when that one ends.
    private var reloadPending = false

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

            var widening = false
            defer {
                if widening {
                    load(paths: self.paths)
                } else {
                    onLoaded?()
                    onLoaded = nil
                }
            }
            switch result {
            case .success(let list):
                span.end("\(list.prs.count) prs")
                prs = list.prs.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
                errors = list.repos.compactMap { repo in repo.error.map { "\(repo.repo): \($0)" } }
                if let wanted {
                    self.wanted = nil
                    if !select(wanted) {
                        if widen(to: wanted) {
                            widening = true
                            return
                        }
                        errors.append("\(wanted.label) is not among these PRs")
                    }
                }
                if selectedID == nil || selected == nil, let first = prs.first(where: { $0.isMine == true }) ?? prs.first {
                    select(first)
                } else if let current = selected, (current.localWorktree ?? current.repoRoot) != nil,
                          current.proposalStamp != reviewProposalStamp || current.headSha != reviewHeadSha {
                    // "Review with agent" finished, or someone pushed, while this PR was open: show
                    // the new drafts or the new head now.
                    select(current)
                }
            case .failure(let error):
                span.end("failed")
                errors = ["\(error)"]
            }
        }
    }

    /// Selects the PR `ref` names, now when the list has it, else once it loads. `reveal` opens a file
    /// (and a thread on it) in that PR's review once the review exists: after the list, the head fetch
    /// of a PR without a worktree, and the diff load, so one click is enough.
    func request(_ ref: HubPRRef, reveal: PRReveal? = nil) {
        pendingReveal = reveal
        if loading || prs.isEmpty {
            wanted = ref
        } else if !select(ref) {
            if widen(to: ref) {
                reload()
            } else {
                errors.append("\(ref.label) is not among these PRs")
            }
        }
        revealPending()
    }

    /// The pending reveal, once the review on screen is its PR's.
    private func revealPending() {
        guard let pending = pendingReveal, let review, let shown = prs.first(where: { $0.id == reviewPRID }),
              pending.ref.matches(shown) else { return }
        pendingReveal = nil
        HubPerf.log("prs.reveal \(pending.ref.label) \(pending.path) thread=\(pending.threadID ?? "-")")
        review.reveal(path: pending.path, thread: pending.threadID)
    }

    /// A merged or closed PR (a "merged" notification's click, a link) is only in the All list: the
    /// picker moves to All once and the next load selects it. False when the list already is All.
    private func widen(to ref: HubPRRef) -> Bool {
        guard state != "all" else { return false }
        wanted = ref
        state = "all"
        return true
    }

    /// Selects the one PR `ref` names; false when none matches. A bare number found in several
    /// projects selects nothing and says which projects, since picking one would be a guess.
    @discardableResult
    private func select(_ ref: HubPRRef) -> Bool {
        let matches = prs.filter(ref.matches)
        if matches.count > 1 {
            let projects = matches.map(\.repo).joined(separator: ", ")
            errors.append("\(ref.label) is in \(matches.count) projects (\(projects)); name one: <project>#\(ref.number)")
            return true
        }
        guard let match = matches.first else { return false }
        select(match)
        return true
    }

    func reload() {
        let current = paths
        load(paths: current)
    }

    /// The embedded review of `pr` at `path`: its worktree, or the main checkout with `fetch` naming the
    /// head there. Rebuilt only when the PR, the folder, the stored proposal or the head changed.
    private func showReview(_ pr: HubPR, path: String, fetch: HubPRFetch?) {
        // Same PR in a different worktree: the old model still points at the old checkout.
        guard reviewPRID != pr.id || review?.repo.path != URL(fileURLWithPath: path).path
            || reviewProposalStamp != pr.proposalStamp || reviewHeadSha != pr.headSha else { return }
        if reviewPRID == pr.id, reviewHeadSha != pr.headSha {
            // A new head can come with a new recorded base (a rebase): fetch the detail again.
            details[pr.id] = nil
        }
        reviewPRID = pr.id
        reviewProposalStamp = pr.proposalStamp
        reviewHeadSha = pr.headSha
        let next = ReviewModel(repo: URL(fileURLWithPath: path), options: DiffViewOptions())
        next.embedded = true
        next.scope = Self.scope(pr, detail: details[pr.id], fetch: fetch)
        if let fetch {
            // The main checkout is on another branch: file actions open the host's copy at the head.
            next.remoteHead = ReviewRemoteHead(branch: pr.headBranch, sha: fetch.head, base: fetch.mergeBase ?? fetch.base,
                                               hostURL: { path, line in pr.blobURL(fetch.head, path: path, line: line) })
        }
        // The PR's live threads on their lines, with reply / resolve / submit (`tools hub pr`).
        next.attachPR(.ref(pr.url.isEmpty ? "\(path)#\(pr.number)" : pr.url))
        // The agent's drafts sit on the lines they are about, with accept / edit / reject.
        if let proposal = pr.proposal {
            do {
                next.proposal = try ProposalDocument(url: URL(fileURLWithPath: proposal.path))
            } catch {
                HubPerf.log("prs.proposal unreadable \(proposal.path): \(error)")
            }
        }
        review = next
        revealPending()
    }

    /// Back or Forward to a PR that left the list (merged, closed, another state picked): nothing is
    /// shown under its id, so the detail and the history agree instead of the last PR staying on screen.
    func showUnavailable(_ id: String) {
        pendingReveal = nil
        selectedID = id
        clearReview()
    }

    private func clearReview() {
        review = nil
        reviewPRID = nil
        reviewProposalStamp = nil
        reviewHeadSha = nil
    }

    /// The fetched head of a PR without a worktree, when it was fetched for the head the list names now.
    private func fetchedHead(_ pr: HubPR) -> HubPRFetch? {
        guard pr.localWorktree == nil, let entry = fetches[pr.id], entry.forHead == pr.headSha,
              case .fetched(let fetch) = entry.state else { return nil }
        return fetch
    }

    /// What the PR header shows while the diff of a PR without a worktree is not there.
    func fetchState(_ pr: HubPR) -> PRFetchState? {
        guard pr.localWorktree == nil, let entry = fetches[pr.id], entry.forHead == pr.headSha else { return nil }
        return entry.state
    }

    /// `tools hub pr fetch` off the main thread, once per head; the review appears when it lands.
    private func fetchHead(_ pr: HubPR, root: String) {
        let key = pr.id
        let head = pr.headSha
        fetches[key] = PRFetchEntry(forHead: head, state: .fetching)
        let args = PRFetch.arguments(pr, root: root, base: details[key]?.baseSha)
        Task {
            let span = HubPerf.begin("prs.fetch", "\(pr.repo) \(pr.label)", awaits: true)
            let state = await Task.detached(priority: .userInitiated) { PRFetch.run(args) }.value
            switch state {
            case .fetched(let fetch):
                span.end(fetch.fetched ? "fetched" : "local")
                if !fetch.warnings.isEmpty {
                    HubPerf.log("prs.fetch \(pr.label) warnings: \(fetch.warnings.joined(separator: "; "))")
                }
            case .failed(let message):
                span.end("failed")
                HubPerf.log("prs.fetch \(pr.label) failed: \(message)")
            case .fetching:
                span.end()
            }
            // A newer head asked for its own fetch meanwhile: this answer is for the old one.
            guard fetches[key]?.forHead == head else { return }
            fetches[key] = PRFetchEntry(forHead: head, state: state)
            // Only the review: `select` would start a second detail load while the first still runs.
            if selectedID == key, let current = selected, let root = current.repoRoot, let fetch = fetchedHead(current) {
                showReview(current, path: root, fetch: fetch)
            }
        }
    }

    /// The header's Retry after a failed fetch.
    func retryFetch(_ pr: HubPR) {
        guard pr.localWorktree == nil, let root = pr.repoRoot else { return }
        fetchHead(pr, root: root)
    }

    func select(_ pr: HubPR) {
        // Another PR picked meanwhile: a reveal still waiting for the first one no longer applies.
        if let pending = pendingReveal, !pending.ref.matches(pr) {
            pendingReveal = nil
        }
        selectedID = pr.id
        if let path = pr.localWorktree {
            showReview(pr, path: path, fetch: nil)
        } else if let root = pr.repoRoot {
            // No worktree has the branch: the head goes into the main checkout under a private ref and
            // the diff is a range there. Fetching or failed for this very head: the header says which,
            // and only Retry asks again.
            if let fetch = fetchedHead(pr) {
                showReview(pr, path: root, fetch: fetch)
            } else {
                clearReview()
                if fetches[pr.id].map({ $0.forHead != pr.headSha }) ?? true {
                    fetchHead(pr, root: root)
                }
            }
        } else {
            clearReview()
        }
        if let detail = details[pr.id] {
            sessions.load(pr, detail: detail)
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
                if reviewPRID == key, detail.baseSha != nil {
                    review?.setScope(Self.scope(pr, detail: detail, fetch: fetchedHead(pr)))
                }
                sessions.load(pr, detail: detail)
            }
        }
    }

    /// Selects the PR `id` names when the list has it (a `#n` link in a description); false otherwise.
    @discardableResult
    func open(id: String) -> Bool {
        guard let pr = prs.first(where: { $0.id == id }) else { return false }
        select(pr)
        return true
    }

    /// The embedded diff shows one commit of the open PR; false while the PR has no diff.
    @discardableResult
    func showCommit(_ commit: HubPRDetail.Commit) -> Bool {
        guard let review, !commit.sha.isEmpty else { return false }
        review.setScope(.commit(sha: commit.sha, title: commit.title))
        return true
    }

    /// Back from one commit to the whole PR.
    func showWholePR() {
        guard let pr = selected else { return }
        review?.setScope(Self.scope(pr, detail: details[pr.id], fetch: fetchedHead(pr)))
    }

    /// The PR's own base, not the branch scope's guess (which picks master for a stacked PR). The
    /// base commit the host recorded wins over `origin/<base>`, which can be stale or gone: a merged
    /// PR showed +50473 lines against an old `origin/` ref where the host shows +1895. A fetched head
    /// (no worktree) names the head the host has, and a base commit the fetch made sure is here.
    static func scope(_ pr: HubPR, detail: HubPRDetail?, fetch: HubPRFetch? = nil) -> DiffScope {
        // The PR header right above names the head branch; the diff's own label only needs the base.
        let label = "\(pr.label) vs \(pr.baseBranch)"
        let head = fetch?.head ?? pr.headSha ?? "HEAD"
        let branchBase = fetch?.base ?? "origin/\(pr.baseBranch)"
        if let baseSha = detail?.baseSha {
            return .range(base: baseSha, head: head, label: label, fallbackBase: branchBase)
        }
        return .range(base: branchBase, head: head, label: label)
    }
}

// MARK: - Sidebar list

struct PRListView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var prs: PRsModel
    @StateObject private var prefs = GroupPrefs(key: "prs.repos")

    private var statePicker: some View {
        Picker("", selection: Binding(get: { prs.state }, set: { prs.state = $0; prs.reload() })) {
            Text("Open").tag("open")
            Text("Merged").tag("merged")
            Text("All").tag("all")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .instantTooltip("Which PRs/MRs to list")
    }

    /// "Mine" asks the forge (`--mine`), so a toggle reloads the list.
    private var mineToggle: some View {
        Toggle("Mine", isOn: Binding(get: { prs.mineOnly }, set: { prs.mineOnly = $0; prs.reload() }))
            .toggleStyle(.checkbox)
            .font(.system(size: 11.5))
            .fixedSize()
            .instantTooltip("Only PRs/MRs you opened")
    }

    @ViewBuilder
    private var reloadControls: some View {
        if prs.loading {
            ProgressView().controlSize(.small)
        }
        HubNotifyButton(prs: prs)
        IconButton(systemName: "arrow.clockwise", tooltip: "Reload the PR/MR list") { prs.reload() }
    }

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
            // One row when the sidebar is wide enough; two below that. At about 215 pt the single row
            // ran off both edges and "Mine" lost its label (screenshot 2026-09-24 15:08).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    statePicker.frame(width: 170)
                    mineToggle
                    Spacer(minLength: 0)
                    reloadControls
                }
                VStack(alignment: .leading, spacing: 6) {
                    statePicker.frame(maxWidth: .infinity)
                    HStack(spacing: 6) {
                        mineToggle
                        Spacer(minLength: 0)
                        reloadControls
                    }
                }
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
                    if let proposal = pr.proposal {
                        Label("\(proposal.pending)", systemImage: "text.bubble")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundColor(proposal.pending > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                            .instantTooltip("Agent review (\(proposal.decision.replacingOccurrences(of: "_", with: " "))): \(proposal.pending) of \(proposal.drafts) draft comments undecided")
                    }
                    if pr.localWorktree != nil {
                        Image(systemName: "externaldrive.badge.checkmark")
                            .font(.system(size: 10))
                            .foregroundColor(ReviewPalette.dim)
                            .instantTooltip("The branch is checked out locally: New session here works in its worktree")
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
        .instantTooltip("\(pr.label) \(pr.headBranch) → \(pr.baseBranch)\nRight-click for its web pages")
        // The row stays one button (select); its labels' web pages live here, since a link inside
        // the row would turn a click meant to select into a browser tab.
        .contextMenu { linksMenu(pr) }
    }

    @ViewBuilder
    private func linksMenu(_ pr: HubPR) -> some View {
        let kind = pr.isGitLab ? "MR" : "PR"
        let pages: [(String, URL?)] = [
            ("Open the \(kind) \(pr.label)", URL(string: pr.url)),
            ("Open \(pr.author ?? "the author")'s profile", pr.authorURL),
            ("Open branch \(pr.headBranch)", pr.headBranchURL),
            ("Open branch \(pr.baseBranch)", pr.baseBranchURL),
            ("Compare \(pr.baseBranch)...\(pr.headBranch)", pr.compareURL),
        ]
        ForEach(pages.indices, id: \.self) { index in
            if let url = pages[index].1 {
                Button(pages[index].0) { ExternalOpener.open(url) }
            }
        }
        Divider()
        Button("Copy \(kind) URL") { PathOpener.copy(pr.url) }
        Button("Copy branch \(pr.headBranch)") { PathOpener.copy(pr.headBranch) }
    }
}

struct PRStateIcon: View {
    let pr: HubPR

    var body: some View {
        let tone = PRStateTone(pr: pr)
        Image(systemName: tone.symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(tone.color)
            .frame(width: 16)
            .instantTooltip(tone.title)
    }
}

/// "Merged into develop" as a pill in the state's own color; a label that names no state stays grey.
struct PRLabelPill: View {
    let pr: HubPR
    let label: String

    var body: some View {
        let tone = PRStateTone(label: label)
        ExternalLink(
            text: label,
            url: pr.forge?.label(label),
            font: .system(size: 10.5, weight: tone == nil ? .regular : .medium),
            color: tone?.color ?? ReviewPalette.dim,
            glyph: .onHover,
            tooltip: "\(pr.isGitLab ? "MRs" : "PRs") labelled \(label)"
        )
        .padding(.horizontal, 6)
        .background(Capsule().fill((tone?.color ?? Color.white).opacity(tone == nil ? 0.08 : 0.16)))
        .overlay(Capsule().stroke(tone?.color.opacity(0.35) ?? Color.clear))
    }
}

struct CIBadge: View {
    let ci: String?
    /// The checks page; the badge opens it when set.
    var url: URL?

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
            let icon = Image(systemName: symbol).font(.system(size: 11)).foregroundColor(color)
            if let url {
                Button { ExternalOpener.open(url) } label: { icon }
                    .buttonStyle(.genHoverIcon())
                    .instantTooltip("CI: \(ci). Open the checks\n\(url.absoluteString)")
                    .accessibilityLabel(Text("CI: \(ci)"))
                    .accessibilityRemoveTraits(.isButton)
                    .accessibilityAddTraits(.isLink)
                    .accessibilityValue(Text(url.absoluteString))
            } else {
                icon.instantTooltip("CI: \(ci)")
            }
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
    // Folded sections, one key each so every PR opens the same way.
    @AppStorage("hub.prs.fold.description") private var foldDescription = false
    @AppStorage("hub.prs.fold.sessions") private var foldSessions = false
    @AppStorage("hub.prs.fold.commits") private var foldCommits = false
    @AppStorage("hub.prs.fold.checks") private var foldChecks = false
    @State private var launching = false
    @State private var reviewing = false
    @State private var width: CGFloat = 0
    @State private var find = PanelFindModel(scope: "pr.overview", title: "this PR")

    /// The first message of a review session. Only the PR's URL comes from outside, and it came from
    /// `tools hub pr list`, not from a page; the agent pushes a proposal and never posts.
    static func reviewPrompt(_ pr: HubPR) -> String {
        "Review \(pr.url) with the genesis-tools:review-proposal skill: read the diff and its existing review threads, decide a verdict, draft comments anchored to the changed lines, and push the proposal with `tools hub proposal push` so it shows in the GenesisTools hub. Do not post, approve or merge anything on the PR."
    }

    private var detail: HubPRDetail? { prs.details[pr.id] }

    /// The overview may take 60% of the width; below its minimum it folds to a rail.
    private static let overviewFraction: CGFloat = 0.6
    private static let overviewMinWidth: CGFloat = 320

    var body: some View {
        VStack(spacing: 0) {
            header
            if showDiff, let review = prs.review {
                let room = width * Self.overviewFraction
                // The shared panel (glowing grip, drag past the minimum to fold, width saved on
                // release) instead of NSSplitView's bare divider.
                SideSplit(panelEdge: .leading, maxFraction: Self.overviewFraction) {
                    ResizableSidePanel(key: "prs.overview", edge: .leading, title: "PR", defaultWidth: 460,
                                       minWidth: Self.overviewMinWidth, maxWidth: max(Self.overviewMinWidth, room),
                                       autoCollapse: width > 0 && room < Self.overviewMinWidth) {
                        overview.hubSurface(.content)
                    }
                    ReviewRootView(model: review)
                        .freezesWidthWhileResizing(heavy: false)
                }
                .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
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
                statePill
                CIBadge(ci: pr.ci, url: detail?.webUrls?.checks.flatMap(URL.init(string:)))
                Spacer()
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.contains("failed") || notice.hasPrefix("cmux:")) { model.notice = nil }
                }
                if prs.review != nil {
                    Toggle("Diff", isOn: $showDiff)
                        .toggleStyle(.button)
                        .instantTooltip(pr.localWorktree == nil
                            ? "Show the \(pr.isGitLab ? "MR" : "PR") diff beside it (its head, fetched into \(pr.repo) without a checkout)"
                            : "Show the branch diff beside the PR")
                } else if let fetch = prs.fetchState(pr) {
                    PRFetchStatus(pr: pr, state: fetch) { prs.retryFetch(pr) }
                }
                if let path = pr.localWorktree ?? pr.repoRoot {
                    Button {
                        reviewing = true
                    } label: {
                        Label(pr.proposal == nil ? "Review with agent" : "Review again", systemImage: "checklist")
                    }
                    .instantTooltip("Start an agent that reviews this PR and pushes its verdict and draft comments here; nothing is posted")
                    .popover(isPresented: $reviewing, arrowEdge: .bottom) {
                        LaunchPicker(mode: .new(cwd: path, name: "review \(pr.repo) \(pr.label)", prompt: Self.reviewPrompt(pr))) { outcome in
                            reviewing = false
                            if let notice = outcome.notice { model.notice = notice }
                        }
                    }
                    // The palette's "review": the same popover, with the command shown before Start.
                    .onChange(of: prs.reviewRequested, initial: true) { _, wanted in
                        guard wanted else { return }
                        prs.reviewRequested = false
                        reviewing = true
                    }
                }
                if let path = pr.localWorktree {
                    Button {
                        launching = true
                    } label: {
                        Label("New session here", systemImage: "plus.bubble")
                    }
                    .instantTooltip("Start Claude, Codex or Grok in the PR's worktree; pick the terminal target first")
                    .popover(isPresented: $launching, arrowEdge: .bottom) {
                        LaunchPicker(mode: .new(cwd: path, name: "\(pr.repo) \(pr.label)")) { outcome in
                            launching = false
                            if let notice = outcome.notice { model.notice = notice }
                        }
                    }
                }
            }
            HStack(spacing: 10) {
                ExternalLink(
                    text: pr.author ?? "unknown",
                    url: pr.authorURL,
                    font: .system(size: 11.5),
                    icon: "person.crop.circle",
                    glyph: .onHover,
                    tooltip: pr.author.map { "\($0)'s profile" }
                )
                branches
                if let detail {
                    let filesURL = detail.webUrls?.files.flatMap(URL.init(string:))
                    if let files = detail.changedFiles {
                        ExternalLink(
                            text: "\(files) files",
                            url: filesURL,
                            font: .system(size: 11.5),
                            glyph: .onHover,
                            tooltip: "The changed files on the \(pr.isGitLab ? "MR" : "PR")"
                        )
                    }
                    if let add = detail.additions, let del = detail.deletions {
                        lineStat(added: add, removed: del, url: filesURL)
                    }
                    if let mergeable = detail.mergeable {
                        Text(mergeable).foregroundColor(mergeable == "conflicting" ? ReviewPalette.removed : ReviewPalette.dim)
                    }
                }
                if let approvals = pr.approvals, approvals > 0 {
                    Label("\(approvals)", systemImage: "hand.thumbsup").instantTooltip("\(approvals) approvals")
                }
                ForEach(pr.labels, id: \.self) { label in
                    PRLabelPill(pr: pr, label: label)
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

    /// Open / Draft / Merged / Closed in the same color as the state icon.
    private var statePill: some View {
        let tone = PRStateTone(pr: pr)
        return Text(tone.title)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundColor(tone.color)
            .padding(.horizontal, 7)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(tone.color.opacity(0.16)))
            .overlay(Capsule().stroke(tone.color.opacity(0.35)))
            .fixedSize()
            .instantTooltip("\(pr.isGitLab ? "MR" : "PR") state: \(tone.title)")
    }

    /// `+33560 −2119`: with a diff (a worktree, or the head fetched) a click shows the whole PR beside
    /// the overview, and ↗ or the context menu opens the changed files on the host; without one it opens the host.
    @ViewBuilder
    private func lineStat(added: Int, removed: Int, url: URL?) -> some View {
        let label = HStack(spacing: 5) {
            Text(verbatim: "+\(added)").foregroundColor(ReviewPalette.added)
            Text(verbatim: "−\(removed)").foregroundColor(ReviewPalette.removed)
        }
        let hostPage = pr.isGitLab ? "MR's changes" : "PR's files"
        if prs.review != nil {
            HStack(spacing: 2) {
                Button { showWholeDiff() } label: { label }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Lines added and removed: show the whole \(pr.isGitLab ? "MR" : "PR") in the diff here" + (url == nil ? "" : "\n↗ or right-click opens the \(hostPage) on the host"))
                    .accessibilityLabel(Text(verbatim: "+\(added) −\(removed) lines, show the diff"))
                if let url {
                    IconButton(systemName: "arrow.up.right", tooltip: "Open the \(hostPage) on the host\n\(url.absoluteString)", size: 9.5) {
                        ExternalOpener.open(url)
                    }
                }
            }
            .contextMenu {
                Button("Show the diff here") { showWholeDiff() }
                if let url {
                    Button("Open the \(hostPage) on the host") { ExternalOpener.open(url) }
                    Button("Copy the URL") { PathOpener.copy(url.absoluteString) }
                }
            }
        } else if let url {
            Button { ExternalOpener.open(url) } label: { label }
                .buttonStyle(.genHoverPlain())
                .onHover { inside in
                    if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                .instantTooltip("Lines added and removed: open the \(pr.isGitLab ? "MR's changes" : "PR's files") on the host\n\(url.absoluteString)")
                .accessibilityRemoveTraits(.isButton)
                .accessibilityAddTraits(.isLink)
                .accessibilityLabel(Text(verbatim: "+\(added) −\(removed) lines"))
        } else {
            label
        }
    }

    /// The diff pane beside the overview, on the PR's whole range (not one commit).
    private func showWholeDiff() {
        showDiff = true
        prs.showWholePR()
        HubPerf.log("prs.lineStat showed the diff of \(pr.label)")
    }

    /// `head → base`: each branch opens its page, the arrow opens the compare view. One line,
    /// shortened in the middle: at 1000 pt the plain text wrapped to four lines.
    private var branches: some View {
        let font = Font.system(size: 11.5, design: .monospaced)
        return HStack(spacing: 4) {
            ExternalLink(text: pr.headBranch, url: pr.headBranchURL, font: font, glyph: .onHover, tooltip: "Head branch \(pr.headBranch)")
                .layoutPriority(1)
            ExternalLink(text: "→", url: pr.compareURL, font: font, glyph: .onHover, tooltip: "Compare \(pr.baseBranch)...\(pr.headBranch)")
            ExternalLink(text: pr.baseBranch, url: pr.baseBranchURL, font: font, glyph: .onHover, tooltip: "Base branch \(pr.baseBranch)")
        }
        .contextMenu {
            Button("Copy head branch") { PathOpener.copy(pr.headBranch) }
            Button("Copy base branch") { PathOpener.copy(pr.baseBranch) }
        }
    }

    /// What the description linker knows: this project's host, and the branches it can vouch for.
    private var linkContext: PRLinkContext {
        let project = pr.project
        let siblings = prs.prs.filter { $0.project == project }
        var branches = Set(detail?.branchMentions ?? [])
        for other in siblings + [pr] {
            branches.insert(other.headBranch)
            branches.insert(other.baseBranch)
        }
        let kindMatches = pr.isGitLab
        return PRLinkContext(forge: pr.forge, branches: branches) { number in
            siblings.first { $0.number == number && $0.isGitLab == kindMatches }?.id
        }
    }

    private var overview: some View {
        // The find bar is its own row above the scroll view, not a top inset over it: selectable
        // description text drew through the inset's background.
        VStack(spacing: 0) {
            PanelFindBar(find: find)
            overviewScroll
        }
        .onAppear { PRChecksSection.prepareSnapshot() }
        .panelFind(find, revision: findRevision, onReveal: unfold, rows: findRows)
    }

    private var overviewScroll: some View {
        ScrollView {
            // Lazy, rows included: every realized row is a focus responder, and SwiftUI walks all of
            // them whenever a sidebar group folds (1.1 s of main thread with #424's 92 commits shown).
            LazyVStack(alignment: .leading, spacing: 0) {
                PRSessionsSection(model: model, prs: prs, store: prs.sessions, pr: pr, folded: $foldSessions)
                    .id(Self.sessionsID)
                if let body = detail?.body?.trimmed, !body.isEmpty {
                    PRSection(title: "Description", folded: $foldDescription) {
                        MarkdownContentView(markdown: PRDescriptionLinker.linkify(body, context: linkContext))
                            .findField("desc")
                            .findRow(Self.descriptionID)
                            .tint(Color(red: 0.62, green: 0.78, blue: 1))
                            .environment(\.openURL, OpenURLAction { url in
                                if let id = PRDescriptionLinker.prID(from: url) {
                                    if !prs.open(id: id) { model.notice = "That PR is no longer in the list" }
                                } else {
                                    ExternalOpener.open(url)
                                }
                                return .handled
                            })
                    }
                    .id(Self.descriptionSectionID)
                } else if detail == nil {
                    ProgressView().controlSize(.small)
                }
                if let commits = detail?.commits, !commits.isEmpty {
                    if let review = prs.review {
                        PRCommitsSection(prs: prs, review: review, pr: pr, commits: commits, folded: $foldCommits) {
                            showDiff = true
                        }
                    } else {
                        PRSection(title: "Commits", count: commits.count, folded: $foldCommits, flat: true) {
                            ForEach(commits.reversed()) { commit in
                                PRCommitRow(pr: pr, commit: commit, selected: false, inApp: false) {
                                    if let url = pr.commitURL(commit.sha) { ExternalOpener.open(url) }
                                }
                            }
                        }
                    }
                }
                if let checks = detail?.checks, !checks.isEmpty {
                    PRChecksSection(model: model, pr: pr, checks: checks, folded: $foldChecks)
                        .id(Self.checksID)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Find (⌘F in the overview)

    private static let sessionsID = "pr.sessions"
    private static let descriptionSectionID = "pr.description.section"
    private static let descriptionID = "pr.description"
    private static let checksID = "pr.checks"

    /// Changes when anything the overview shows changes: the sessions found, the detail, the PR.
    private var findRevision: [String] {
        let sessions = PRSessionsSection.rows(model: model, store: prs.sessions, pr: pr).map(\.id)
        return sessions + [detail?.body ?? "", pr.id] + (detail?.commits ?? []).map(\.sha) + (detail?.checks ?? []).map(\.id)
    }

    /// Sessions, description, commits and checks, in the order the overview shows them.
    private func findRows() -> [PanelFindRow] {
        var rows = PRSessionsSection.rows(model: model, store: prs.sessions, pr: pr).map { row in
            PanelFindRow(id: "session:\(row.id)", fields: [PanelFindField("title", row.session.displayTitle)], container: Self.sessionsID)
        }
        if let body = detail?.body?.trimmed, !body.isEmpty {
            let markdown = PRDescriptionLinker.linkify(body, context: linkContext)
            rows.append(PanelFindRow(id: Self.descriptionID, fields: [PanelFindField("desc", markdown, markdown: true)], container: Self.descriptionSectionID))
        }
        rows += (detail?.commits ?? []).reversed().map(PRCommitRow.searchable)
        rows += PRChecksSection.sorted(detail?.checks ?? []).map { check in
            PanelFindRow(id: "check:\(check.id)", fields: [PanelFindField("link", check.name)], container: Self.checksID)
        }
        return rows
    }

    /// A match in a folded section opens it first.
    private func unfold(_ match: PanelFindMatch) {
        if match.row.hasPrefix("session:") {
            foldSessions = false
        } else if match.row == Self.descriptionID {
            foldDescription = false
        } else if match.row.hasPrefix("check:") {
            foldChecks = false
        } else {
            foldCommits = false
        }
    }
}

/// A section of the PR overview whose title folds it; the fold is saved by the caller.
struct PRSection<Content: View>: View {
    let title: String
    var count: Int?
    @Binding var folded: Bool
    /// The rows join the overview's lazy stack instead of one block: rows off screen are never made.
    var flat = false
    var trailing: AnyView?
    @ViewBuilder let content: () -> Content

    init(title: String, count: Int? = nil, folded: Binding<Bool>, flat: Bool = false, trailing: AnyView? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.count = count
        _folded = folded
        self.flat = flat
        self.trailing = trailing
        self.content = content
    }

    var body: some View {
        if flat {
            header.padding(.bottom, folded ? 16 : 8)
            if !folded {
                content()
                Color.clear.frame(height: 16)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                header
                if !folded {
                    content()
                }
            }
            .padding(.bottom, 16)
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.18)) { folded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(folded ? 0 : 90))
                    Text(title).font(.system(size: 11.5, weight: .semibold))
                    if let count {
                        Text(verbatim: "\(count)").font(.system(size: 10.5, design: .monospaced))
                    }
                }
                .foregroundColor(ReviewPalette.dim)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(folded ? "Show \(title.lowercased())" : "Hide \(title.lowercased())")
            .accessibilityLabel(Text(title))
            .accessibilityValue(Text(folded ? "folded" : "shown"))
            Spacer(minLength: 0)
            trailing
        }
    }
}

// MARK: - Commits

/// The PR's commits, newest first. A click shows that commit in the diff beside it; "Whole PR"
/// goes back to the PR's range.
struct PRCommitsSection: View {
    @ObservedObject var prs: PRsModel
    @ObservedObject var review: ReviewModel
    let pr: HubPR
    let commits: [HubPRDetail.Commit]
    @Binding var folded: Bool
    let revealDiff: () -> Void

    private var shownSha: String? {
        if case .commit(let sha, _) = review.scope { return sha }
        return nil
    }

    var body: some View {
        let shown = shownSha
        PRSection(title: "Commits", count: commits.count, folded: $folded, flat: true, trailing: shown == nil ? nil : AnyView(
            Button("Whole PR") { prs.showWholePR() }
                .buttonStyle(.genHoverPlain())
                .font(.system(size: 11.5))
                .instantTooltip("Show the whole \(pr.isGitLab ? "MR" : "PR") in the diff again")
        )) {
            ForEach(commits.reversed()) { commit in
                PRCommitRow(pr: pr, commit: commit, selected: commit.sha == shown, inApp: true) {
                    if prs.showCommit(commit) { revealDiff() }
                }
            }
        }
    }
}

/// One commit: short sha, title, author, age. The row shows it in the hub (or opens it on the host
/// when there is no local checkout); ↗ and the context menu open the host page.
struct PRCommitRow: View {
    let pr: HubPR
    let commit: HubPRDetail.Commit
    let selected: Bool
    let inApp: Bool
    let action: () -> Void

    var body: some View {
        let hostURL = pr.commitURL(commit.sha)
        HStack(spacing: 4) {
            HStack(spacing: 8) {
                FindText(String(commit.sha.prefix(8)), field: "sha")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(selected ? Color(red: 0.62, green: 0.78, blue: 1) : ReviewPalette.dim)
                FindText(commit.title, field: "title")
                    .font(.system(size: 12))
                    .foregroundColor(Color.white.opacity(0.9))
                    .lineLimit(1)
                    .truncationMode(.tail)
                if commit.body != nil {
                    Image(systemName: "text.alignleft")
                        .font(.system(size: 9))
                        .foregroundColor(ReviewPalette.dim)
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 6)
                if let author = commit.author {
                    FindText(author, field: "author").font(.system(size: 11)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                }
                Text(verbatim: HubFormat.ago(commit.when))
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.08) : Color.clear))
            .contentShape(Rectangle())
            .rowButton(cornerRadius: 6, action)
            .findRow(commit.sha, cornerRadius: 6)
            .instantTooltip(tooltip)
            if let hostURL {
                IconButton(systemName: "arrow.up.right.square", tooltip: "Open commit \(commit.sha.prefix(8)) on the host", size: 10) {
                    ExternalOpener.open(hostURL)
                }
            }
        }
        .contextMenu {
            if let hostURL {
                Button("Open on the host") { ExternalOpener.open(hostURL) }
            }
            if let login = commit.authorLogin, let profile = pr.forge?.user(login) {
                Button("Open \(login)'s profile") { ExternalOpener.open(profile) }
            }
            Divider()
            Button("Copy commit sha") { PathOpener.copy(commit.sha) }
            Button("Copy title") { PathOpener.copy(commit.title) }
        }
    }

    /// What ⌘F searches in a commit row, under the keys its FindTexts use.
    static func searchable(_ commit: HubPRDetail.Commit) -> PanelFindRow {
        PanelFindRow(id: commit.sha, fields: [
            PanelFindField("sha", String(commit.sha.prefix(8))),
            PanelFindField("title", commit.title),
            PanelFindField("author", commit.author ?? ""),
        ])
    }

    private var tooltip: String {
        var lines = [commit.title]
        if let body = commit.body {
            lines += ["", String(body.prefix(600))]
        }
        let when = commit.when.map { PRSessionRow.exact.string(from: $0) } ?? "unknown time"
        lines += ["", "\(commit.sha.prefix(12)) · \(commit.author ?? "unknown") · \(when)"]
        lines.append(inApp ? "Click: show this commit in the diff. ↗ or right-click: the host page" : "Click: open it on the host")
        return lines.joined(separator: "\n")
    }
}

// MARK: - Sessions

/// Every agent session that touched the PR. The hub's own recent rows show at once; `tools hub pr
/// sessions` adds older ones and the commit and file evidence when it answers.
struct PRSessionsSection: View {
    @ObservedObject var model: HubModel
    @ObservedObject var prs: PRsModel
    @ObservedObject var store: PRSessionsStore
    let pr: HubPR
    @Binding var folded: Bool

    fileprivate struct Row: Identifiable {
        let session: HubSession
        let reasons: [String]
        var files: [String] = []
        var fileCount = 0
        var commits: [String] = []
        var id: String { session.sessionId }
    }

    /// The hub's recent sessions on the branch: by the branch the transcript recorded, or by folder.
    private static func quick(model: HubModel, pr: HubPR) -> [Row] {
        model.sessions.compactMap { session in
            if session.gitBranch == pr.headBranch {
                return Row(session: session, reasons: ["branch"])
            }
            if let worktree = pr.localWorktree, session.gitBranch == nil, session.cwd == worktree || session.cwd.hasPrefix(worktree + "/") {
                return Row(session: session, reasons: ["worktree"])
            }
            return nil
        }
    }

    private var rows: [Row] { Self.rows(model: model, store: store, pr: pr) }

    /// The rows in the order the section lists them (the overview's find reads the same list).
    fileprivate static func rows(model: HubModel, store: PRSessionsStore, pr: HubPR) -> [Row] {
        let recent = quick(model: model, pr: pr)
        guard let found = store.results[pr.id] else { return recent }
        let live = Dictionary(model.sessions.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
        var rows = found.sessions.map { match in
            Row(session: live[match.sessionId] ?? match.hit.sessionRow, reasons: match.reasons,
                files: match.files, fileCount: match.fileCount, commits: match.commits)
        }
        let known = Set(rows.map(\.id))
        // A session started since the index last saw it: the hub's list already has it.
        rows += recent.filter { !known.contains($0.id) }
        return rows
    }

    var body: some View {
        let rows = rows
        let loading = store.loading.contains(pr.id)
        PRSection(title: "Sessions", count: rows.count, folded: $folded, trailing: AnyView(
            HStack(spacing: 6) {
                if loading {
                    ProgressView().controlSize(.mini)
                }
                if pr.repoRoot != nil {
                    IconButton(systemName: "arrow.clockwise", tooltip: "Look for sessions again (tools hub pr sessions --no-cache)", size: 10) {
                        store.load(pr, detail: prs.details[pr.id], fresh: true)
                    }
                    .disabled(loading)
                }
            }
        )) {
            if rows.isEmpty {
                Text(emptyText(loading: loading))
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
            }
            ForEach(rows) { row in
                PRSessionRow(model: model, session: row.session, reasons: row.reasons, files: row.files,
                             fileCount: row.fileCount, commits: row.commits)
                    .findRow("session:\(row.id)", cornerRadius: 6)
            }
            if let error = store.errors[pr.id] {
                Text(verbatim: "Session search failed: \(error)")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.removed)
                    .lineLimit(2)
            }
        }
    }

    private func emptyText(loading: Bool) -> String {
        if loading { return "Looking through the agent sessions…" }
        if pr.repoRoot == nil { return "No local checkout of this project, so no session can be matched." }
        return "No session worked on this branch, its commits or its files."
    }
}
