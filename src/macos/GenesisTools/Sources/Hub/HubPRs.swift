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
    fileprivate(set) var localWorktree: String?
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
    /// The PR's page when the ref came from one (the browser extension, a link): `tools hub pr show`
    /// takes it as is, so a PR of a project outside the list still opens.
    var pageURL: String?

    init(project: String?, number: Int, pageURL: String? = nil) {
        self.project = project
        self.number = number
        self.pageURL = pageURL
    }

    /// `group/app!7`: a GitLab merge request, whose page needs a host only its checkout knows.
    var isMergeRequest = false

    /// What `tools hub pr show` can fetch with no local checkout: the page, else a GitHub
    /// `owner/repo` PR. Never for a merge request: a github.com guess opened another project or
    /// failed with a host error that hid the real cause.
    var showURL: String? {
        if let pageURL { return pageURL }
        guard !isMergeRequest, let project, project.split(separator: "/").count == 2 else { return nil }
        return "https://github.com/\(project)/pull/\(number)"
    }

    /// The forge host of the page this ref came from; nil for a path-only ref.
    var host: String? { pageURL.flatMap { URL(string: $0)?.host?.lowercased() } }

    /// The same ref with the PR's page attached, when the caller holds it (Activity rows do).
    func withPage(_ url: String?) -> HubPRRef {
        guard let url, !url.isEmpty else { return self }
        var copy = self
        copy.pageURL = url
        return copy
    }

    init?(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if let page = Self.fromPageURL(text) {
            self = page
            return
        }
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
        isMergeRequest = text[split] == "!"
    }

    /// A PR or MR page: `https://github.com/owner/repo/pull/42/files`,
    /// `https://gitlab.example/group/app/-/merge_requests/12`. The browser extension and links pass these.
    private static func fromPageURL(_ text: String) -> HubPRRef? {
        guard let url = URL(string: text), url.scheme == "https" || url.scheme == "http" else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        if let at = parts.firstIndex(of: "pull"), at >= 2, at + 1 < parts.count, let number = Int(parts[at + 1]) {
            return HubPRRef(project: parts[..<at].joined(separator: "/"), number: number, pageURL: text)
        }
        if let at = parts.firstIndex(of: "merge_requests"), at >= 3, parts[at - 1] == "-", at + 1 < parts.count,
           let number = Int(parts[at + 1]) {
            return HubPRRef(project: parts[..<(at - 1)].joined(separator: "/"), number: number, pageURL: text)
        }
        return nil
    }

    /// The project matches the folder name (`app`), the web path (`group/app`) or the whole key, in any
    /// letter case: GitHub and GitLab paths are case-insensitive, and a typed or lowercased URL is common.
    func matches(_ pr: HubPR) -> Bool {
        guard pr.number == number else { return false }
        // Two clones of `team/app` on different forges share a path: the page's host tells them apart.
        if let host, let rowHost = pr.origin?.host?.lowercased(), host != rowHost { return false }
        guard let project else { return true }
        let wanted = project.lowercased()
        let key = pr.project.lowercased()
        return pr.repo.lowercased() == wanted || key == wanted || key.hasSuffix("/" + wanted)
    }

    var label: String { project.map { "\($0)#\(number)" } ?? "#\(number)" }
}

/// A forge project with a checkout under the repo roots (`tools hub pr projects`).
struct HubPRProject: Decodable, Equatable, Identifiable {
    let project: String
    let repo: String
    let root: String
    let kind: String
    var id: String { project }
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
    /// The head this detail describes; a newer one than the list's row means a push since the list.
    let headSha: String?
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
        let count: Int?
        let origin: HubPR.Origin?
    }

    let prs: [HubPR]
    let repos: [Repo]

    private enum CodingKeys: String, CodingKey { case prs, repos }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        repos = try container.decode([Repo].self, forKey: .repos)
        // A cached list can name a worktree deleted since (a review's scratch checkout): its diff failed
        // with "commit … is not in <path>" instead of fetching the head into the main checkout.
        prs = try container.decode([HubPR].self, forKey: .prs).map { pr in
            guard let path = pr.localWorktree, !FileManager.default.fileExists(atPath: path) else { return pr }
            var live = pr
            live.localWorktree = nil
            return live
        }
    }
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
        didSet {
            HubDefaults.store.set(state, forKey: "hub.prs.state")
            HubMainBusy.measure("prs.filter.state")
        }
    }
    @Published var mineOnly = HubDefaults.store.bool(forKey: "hub.prs.mine") {
        didSet {
            HubDefaults.store.set(mineOnly, forKey: "hub.prs.mine")
            HubMainBusy.measure("prs.filter.mine")
        }
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
    static let pageSize = 40
    /// PRs per project the list asks for; "Load more" adds a page.
    @Published private(set) var limit = PRsModel.pageSize
    /// Projects whose last answer was a full page, so the forge may hold more: each gets its own
    /// "Load more" (one button for every project asked them all for another page).
    @Published private(set) var fullProjects: Set<String> = []
    /// Every forge project cloned under the repo roots, not only the session projects the list starts
    /// from: a project with no recent session (Reservine/ReservineBack, 2026-10-04) was missing.
    @Published private(set) var allProjects: [HubPRProject] = []
    /// Projects whose own page (`loadProject`) is loading.
    @Published private(set) var projectLoading: Set<String> = []
    /// Projects opened from "More projects" or given a bigger page: their checkouts join every list
    /// load, and a page bigger than the list's is asked for again after it.
    private var extraRoots: [String: String] = [:]
    private var projectLimits: [String: Int] = [:]
    /// Counts each project's own loads, so a request superseded by a filter change or a removal never
    /// overwrites the rows a later one (or none) put there.
    private var projectGeneration: [String: Int] = [:]
    private var projectsRequested = false
    /// The rows on screen came from the disk cache and the fresh list is still loading.
    @Published private(set) var showingCache = false
    /// Rows that are new or whose update time moved in the last refresh; they flash once.
    @Published private(set) var changed: Set<String> = []
    /// The forge-side search (`--query`), taken from the sidebar filter.
    private(set) var query = ""
    /// The cache key of the list on screen; a new key (state, mine, search) starts at its cached page.
    private var shownKey: String?
    /// Counts list loads, so a cached list read off the main actor never paints over a newer request
    /// or over the fresh answer that came first.
    private var listGeneration = 0
    private var freshGeneration = -1
    /// The key of the rows on screen (the cache paints before the fresh answer).
    private var appliedKey: String?
    private var lastLoad: Date?
    private var searchTask: Task<Void, Never>?
    /// PR details being fetched, and when each last arrived fresh.
    private var detailLoading: Set<String> = []
    private var detailFetched: [String: Date] = [:]
    /// The wanted PR whose detail was already asked for straight away (`startWanted`), so a list load
    /// that lands meanwhile does not ask again.
    private var wantedStarted: HubPRRef?
    /// The deep-linked PR `openDirect` is fetching, and the selection when it started: its answer
    /// still selects it after the list cleared `wanted`, unless someone picked another row meanwhile.
    private var directOpen: (ref: HubPRRef, selectionAtStart: String?)?
    /// The selected PR's live threads, started with its detail: the review adopts the store when it
    /// exists, so the threads never wait for the head fetch and the diff.
    private var prefetchedThreads: PRThreadsStore?
    /// PRs shown from `openDirect` (a link to a PR the list does not hold, another author's under
    /// "Mine"): the open one stays in the rows when a list answers without it.
    private var directIDs: Set<String> = []

    var selected: HubPR? { prs.first { $0.id == selectedID } }

    /// Starred projects (the PR list's pins) are asked for on every load, beside the session projects.
    static var starred: [String] { HubDefaults.store.stringArray(forKey: "groups.prs.repos.pinned") ?? [] }

    private func listPaths(_ sessionPaths: [String]) -> [String] {
        let starredRoots = Self.starred.compactMap { key in allProjects.first { $0.project == key }?.root }
        return Array(Set(sessionPaths + starredRoots + extraRoots.values)).sorted()
    }

    func load(paths sessionPaths: [String]) {
        self.paths = sessionPaths
        guard !loading else {
            reloadPending = true
            return
        }

        loadProjectsIfNeeded()
        let paths = listPaths(sessionPaths)
        guard !paths.isEmpty else { return }
        loading = true
        let state = state
        let query = query
        let mineOnly = mineOnly
        let key = PRListCache.key(paths: paths, state: state, mine: mineOnly, query: query)
        if key != shownKey {
            // Another list (state, mine, search): its last known rows at once, then the fresh ones.
            shownKey = key
            limit = max(Self.pageSize, PRListCache.limit(key))
            // The list for these very projects, else the last list of any projects with the same
            // filters: the project set follows the recent sessions, so the exact key often misses.
            // Read and decoded off the main actor (a widened list carries every description); applied only
            // while this list is still the one shown and its fresh answer has not landed first.
            listGeneration += 1
            let generation = listGeneration
            Task {
                let cached = await Task.detached(priority: .userInitiated) { () -> HubPRList? in
                    guard let data = PRListCache.readList(key) ?? PRListCache.readLastList(state: state, mine: mineOnly, query: query) else { return nil }
                    return try? JSONDecoder().decode(HubPRList.self, from: data)
                }.value
                guard let list = cached, generation == listGeneration, shownKey == key, freshGeneration != generation else { return }
                apply(list, key: key, flash: false)
                showingCache = true
                HubSWR.painted("prs.list", "\(list.prs.count) prs")
                if wanted == nil, selectedID == nil || selected == nil, let first = prs.first(where: { $0.isMine == true }) ?? prs.first {
                    select(first)
                }
            }
        }
        let generation = listGeneration
        // A PR asked for by a link or the browser extension: its detail starts now, from the cached row
        // or straight from its checkout, never after the whole list (11 s for ten projects).
        startWanted()
        let limit = limit
        // Mine asks the forge (`gh --author @me`, glab's own filter): filtering the capped list here
        // lost every authored PR past the first 40.
        let mine = mineOnly ? ["--mine"] : []
        let search = query.isEmpty ? [] : ["--query", query]
        Task {
            let span = HubPerf.begin("prs.list", "\(paths.count) projects state=\(state) mine=\(mineOnly) limit=\(limit) query=\(query.isEmpty ? "-" : "yes")", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<(HubPRList, Data), Error> in
                Result {
                    let data = try ToolsCLIRunner.run(["hub", "pr", "list"] + paths + ["--state", state, "--limit", String(limit)] + mine + search)
                    return (try JSONDecoder().decode(HubPRList.self, from: data), data)
                }
            }.value
            loading = false
            showingCache = false
            lastLoad = Date()
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
            case .success(let (list, data)):
                span.end("\(list.prs.count) prs")
                HubMainBusy.measure("prs.list.render")
                if list.repos.allSatisfy({ $0.error == nil }) {
                    Task.detached(priority: .utility) {
                        PRListCache.writeList(data, key: key, limit: limit, state: state, mine: mineOnly, query: query)
                    }
                }
                freshGeneration = generation
                apply(list, key: key, flash: true)
                // A project given more pages than the list asks each for keeps them after a reload.
                for (projectKey, projectLimit) in projectLimits where projectLimit > limit {
                    if let project = allProjects.first(where: { $0.project == projectKey }) {
                        loadProject(project)
                    }
                }
                // Once per list load, never on a timer (Hub/HubPRReadiness.swift). The open PR's verdict first.
                let selectedID = selectedID
                PRReadinessStore.shared.refresh(prs.filter { $0.id == selectedID } + prs.filter { $0.id != selectedID })
                if let wanted {
                    self.wanted = nil
                    wantedStarted = nil
                    // A deep-linked PR outside the list is on its way from its checkout (`openDirect`):
                    // that answer selects it, so the list neither reports it missing nor picks another row.
                    if !select(wanted), directOpen?.ref != wanted {
                        if widen(to: wanted) {
                            widening = true
                            return
                        }
                        errors.append("\(wanted.label) is not among these PRs")
                    }
                }
                if directOpen == nil, selectedID == nil || selected == nil,
                   let first = prs.first(where: { $0.isMine == true }) ?? prs.first {
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
        HubPerf.log("prs.request \(ref.label) loading=\(loading) rows=\(prs.count)")
        if loading || prs.isEmpty {
            wanted = ref
            wantedStarted = nil
            startWanted()
        } else if !select(ref, opened: true) {
            if widen(to: ref) {
                reload()
            } else {
                // Not in the list (newer than it, or of a project it does not hold): straight from its checkout.
                wanted = ref
                wantedStarted = nil
                if !startWanted() {
                    wanted = nil
                    errors.append("\(ref.label) is not among these PRs")
                }
            }
        }
        revealPending()
    }

    /// The wanted PR before the list answers: its row on screen (the cache's) is selected now, else its
    /// detail comes straight from the checkout its project lives in (`openDirect`). The list still
    /// selects it again when it lands. False when neither is possible yet (no row, no known checkout).
    @discardableResult
    private func startWanted() -> Bool {
        guard let ref = wanted else { return false }
        if wantedStarted == ref { return true }
        let matches = prs.filter(ref.matches)
        if matches.count == 1, let match = matches.first {
            wantedStarted = ref
            HubPerf.log("prs.request \(ref.label) from the row on screen, before the list answers")
            select(match, opened: true)
            return true
        }
        guard matches.isEmpty else { return false }
        // A checkout of the project among the list's folders, else the PR's page: `hub pr show` finds
        // the checkout under the repo roots itself. Without the page fallback a PR of a project with no
        // recent session ("Open in GenesisTools" on Reservine/ReservineBack#815) left another PR open.
        guard let arg = ref.pageURL ?? directRoot(ref).map({ "\($0)#\(ref.number)" }) ?? ref.showURL else { return false }
        wantedStarted = ref
        openDirect(ref, arg: arg)
        return true
    }

    /// The checkout `tools hub pr show <root>#<n>` can answer `ref` from: a row of the same project on
    /// screen names it, else a project folder of the same name. The answer is checked against `ref`.
    private func directRoot(_ ref: HubPRRef) -> String? {
        guard let project = ref.project else { return nil }
        if let root = prs.first(where: { HubPRRef(project: project, number: $0.number).matches($0) })?.repoRoot {
            return root
        }
        // A cloned project whose web path is the ref's, whatever the host: the path form needs no host.
        let wanted = project.lowercased()
        if let match = allProjects.first(where: { $0.project.lowercased().hasSuffix("/" + wanted) }) {
            return match.root
        }
        let name = (project.split(separator: "/").last.map(String.init) ?? project).lowercased()
        return paths.first { URL(fileURLWithPath: $0).lastPathComponent.lowercased() == name }
    }

    /// One PR's row and detail from `tools hub pr show <root>#<n>` (the detail is a list row plus its
    /// body, commits and checks), while the list loads. Its threads and head fetch start once that answer
    /// lands, not with it: for a PR with no cached row only the show names its forge thread target and
    /// its head commit. A cached row (`startWanted`) starts all three at once.
    private func openDirect(_ ref: HubPRRef, arg: String) {
        directOpen = (ref, selectedID)
        Task {
            let span = HubPerf.begin("prs.show.direct", arg, awaits: true)
            let answer = await Task.detached(priority: .userInitiated) { () -> Result<(HubPR, HubPRDetail, Data), Error> in
                Result {
                    let data = try ToolsCLIRunner.run(["hub", "pr", "show", arg])
                    return (try JSONDecoder().decode(HubPR.self, from: data), try JSONDecoder().decode(HubPRDetail.self, from: data), data)
                }
            }.value
            let request = directOpen
            if request?.ref == ref {
                directOpen = nil
            }
            let fresh: (HubPR, HubPRDetail, Data)
            switch answer {
            case .success(let value):
                fresh = value
            case .failure(let error):
                span.end("failed")
                // Said, not swallowed: the list's own answer no longer reports a ref it handed here.
                errors.append("Could not open \(ref.label): \(error)")
                return
            }
            let (row, detail, data) = fresh
            guard ref.matches(row) else {
                span.end("another PR")
                errors.append("\(arg) answered \(row.label), not \(ref.label)")
                return
            }
            span.end(row.label)
            Task.detached(priority: .utility) { PRListCache.writeDetail(data, id: row.id) }
            details[row.id] = detail
            detailFetched[row.id] = Date()
            // Still wanted: the list has not answered, or it answered and nobody picked another row since.
            let untouched = request.map { $0.ref == ref && selectedID == $0.selectionAtStart } ?? false
            guard wanted == ref || untouched || selectedID == row.id else { return }
            if let index = prs.firstIndex(where: { $0.id == row.id }) {
                // The list may have added and selected this PR first, with an older head: the fresh row wins.
                let older = prs[index]
                prs[index] = row
                if selectedID == row.id, older.headSha != row.headSha {
                    // The store already holds this PR at the older head: reload it, as loadDetail does.
                    prefetchThreads(row, headMoved: true)
                    showDiff(row)
                }
            } else {
                directIDs.insert(row.id)
                prs.append(row)
            }
            if selectedID != row.id {
                select(row)
            }
        }
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
    private func select(_ ref: HubPRRef, opened: Bool = false) -> Bool {
        let matches = prs.filter(ref.matches)
        if matches.count > 1 {
            let projects = matches.map(\.repo).joined(separator: ", ")
            errors.append("\(ref.label) is in \(matches.count) projects (\(projects)); name one: <project>#\(ref.number)")
            return true
        }
        guard let match = matches.first else { return false }
        select(match, opened: opened)
        return true
    }

    func reload() {
        let current = paths
        load(paths: current)
    }

    /// The project list for "More projects" and the stars, once per hub run.
    func loadProjectsIfNeeded() {
        guard !projectsRequested else { return }
        projectsRequested = true
        Task {
            let span = HubPerf.begin("prs.projects", awaits: true)
            struct Answer: Decodable { let projects: [HubPRProject] }
            let answer = await Task.detached(priority: .utility) { () -> Result<[HubPRProject], Error> in
                Result { try JSONDecoder().decode(Answer.self, from: ToolsCLIRunner.run(["hub", "pr", "projects"])).projects }
            }.value
            switch answer {
            case .success(let projects):
                span.end("\(projects.count) projects")
                allProjects = projects
                // A starred project the first load could not name yet (the list came before this answer).
                let starredRoots = Self.starred.compactMap { key in projects.first { $0.project == key }?.root }
                if !starredRoots.isEmpty, !starredRoots.allSatisfy({ root in prs.contains { $0.repoRoot == root } }) {
                    reload()
                }
            case .failure(let error):
                span.end("failed")
                projectsRequested = false
                errors.append("Could not list the projects under the repo roots: \(error)")
            }
        }
    }

    /// What one project asks the forge for: its own pages so far, never fewer rows than the list already
    /// holds for it (the list restores its cached limit, which the old global "Load more" raised), plus
    /// a page when `more`. A smaller ask would replace the project's rows with a shorter page.
    static func projectLimit(own: Int?, listed: Int, more: Bool) -> Int {
        max(own ?? pageSize, listed) + (more ? pageSize : 0)
    }

    /// One project's PRs, on its own: opened from "More projects", or one more page of it. Its rows
    /// replace that project's rows; every other project's stay as they are.
    func loadProject(_ project: HubPRProject, more: Bool = false) {
        guard !projectLoading.contains(project.project) else { return }
        let limit = Self.projectLimit(own: projectLimits[project.project], listed: self.limit, more: more)
        projectLimits[project.project] = limit
        extraRoots[project.project] = project.root
        projectLoading.insert(project.project)
        let state = state
        let mineOnly = mineOnly
        let query = query
        let mine = mineOnly ? ["--mine"] : []
        let search = query.isEmpty ? [] : ["--query", query]
        projectGeneration[project.project, default: 0] += 1
        let generation = projectGeneration[project.project]
        Task {
            let span = HubPerf.begin("prs.project", "\(project.repo) limit=\(limit)", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<HubPRList, Error> in
                Result {
                    try JSONDecoder().decode(HubPRList.self, from: ToolsCLIRunner.run(["hub", "pr", "list", project.root, "--state", state, "--limit", String(limit)] + mine + search))
                }
            }.value
            projectLoading.remove(project.project)
            // A filter change, or this project leaving the list, raced this request: its answer
            // belongs to a state that is gone, so it must not overwrite rows for the current one.
            guard generation == projectGeneration[project.project], extraRoots[project.project] != nil,
                self.state == state, self.mineOnly == mineOnly, self.query == query else {
                span.end("superseded")
                // The project itself is still wanted, only under filters that moved while this ran:
                // ask again now, under those, so its page does not stay stuck at the old count.
                if extraRoots[project.project] != nil, generation == projectGeneration[project.project] {
                    loadProject(project)
                }
                return
            }
            switch result {
            case .success(let list):
                span.end("\(list.prs.count) prs")
                let merged = (prs.filter { $0.project != project.project } + list.prs).sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
                withAnimation(SWR.animation) {
                    prs = merged
                    if list.repos.contains(where: { ($0.count ?? 0) >= limit }) {
                        fullProjects.insert(project.project)
                    } else {
                        fullProjects.remove(project.project)
                    }
                }
                if let error = list.repos.compactMap(\.error).first {
                    errors.append("\(project.repo): \(error)")
                } else if list.prs.isEmpty {
                    errors.append("\(project.repo) has no \(state == "all" ? "" : state + " ")PRs/MRs\(mineOnly ? " of yours" : "")")
                }
            case .failure(let error):
                span.end("failed")
                errors.append("Could not load \(project.repo)'s PRs/MRs: \(error)")
            }
        }
    }

    func dismissError(_ text: String) {
        errors.removeAll { $0 == text }
    }

    /// A project opened from "More projects" (not a session project, not starred) leaves the list
    /// again; it stayed until the hub quit.
    func isRemovable(_ key: String) -> Bool {
        extraRoots[key] != nil && !Self.starred.contains(key)
    }

    func removeProject(_ key: String) {
        extraRoots[key] = nil
        projectLimits[key] = nil
        fullProjects.remove(key)
        withAnimation(SWR.animation) {
            prs.removeAll { $0.project == key && $0.id != selectedID }
        }
    }

    /// One more page of the project a group shows.
    func loadMore(project key: String) {
        if let project = allProjects.first(where: { $0.project == key }) {
            loadProject(project, more: true)
            return
        }

        // A session project the projects answer does not hold: its checkout is in its rows.
        guard let root = prs.first(where: { $0.project == key })?.repoRoot else { return }
        loadProject(HubPRProject(project: key, repo: prs.first { $0.project == key }?.repo ?? key, root: root, kind: ""), more: true)
    }

    /// Refreshes a list older than `age` seconds: the hub coming back to the PRs mode shows what it
    /// has and asks the forge again.
    func refreshIfStale(age: TimeInterval = 60) {
        guard !loading, let lastLoad, Date().timeIntervalSince(lastLoad) > age else { return }
        reload()
    }

    /// The sidebar filter as a forge search, after the typing pauses. The rows on screen filter at
    /// once; this finds the PRs past the loaded pages (an older MR by its id or author).
    func search(_ filter: String) {
        let next = filter.trimmed
        // Cancelled first: typing back to the applied query must also drop the search still waiting.
        searchTask?.cancel()
        guard next != query else { return }
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard let self, !Task.isCancelled else { return }
            self.query = next
            self.reload()
        }
    }

    /// Shows `list`, animating rows in and out. `flash` marks new and updated rows once, only when
    /// the list on screen is the same list refreshed (not another state or search).
    private func apply(_ list: HubPRList, key: String, flash: Bool) {
        let sameList = appliedKey == key
        appliedKey = key
        var sorted = list.prs.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        // The open PR came from `openDirect` and this list does not hold it: it stays, at the end.
        if let open = selected, directIDs.contains(open.id), !sorted.contains(where: { $0.id == open.id }) {
            sorted.append(open)
        }
        let before = Dictionary(prs.map { ($0.id, $0.updatedAt ?? "") }, uniquingKeysWith: { first, _ in first })
        let moved: Set<String> = flash && sameList
            ? SWR.changed(before: before, after: sorted.map { ($0.id, $0.updatedAt ?? "") })
            : []
        withAnimation(SWR.animation) {
            prs = sorted
            fullProjects = Set(list.repos.compactMap { repo in (repo.count ?? 0) >= limit ? repo.origin?.web : nil })
            changed = moved
        }
        errors = list.repos.compactMap { repo in repo.error.map { "\(repo.repo): \($0)" } }
        SWR.fade(moved, current: { [weak self] in self?.changed }, clear: { [weak self] in self?.changed = [] })
    }

    /// The embedded review of `pr` at `path`: its worktree, or the main checkout with `fetch` naming the
    /// head there. Rebuilt only when the PR, the folder, the stored proposal or the head changed.
    private func showReview(_ pr: HubPR, path: String, fetch: HubPRFetch?) {
        // Same PR in a different worktree: the old model still points at the old checkout.
        guard reviewPRID != pr.id || review?.repo.path != URL(fileURLWithPath: path).path
            || reviewProposalStamp != pr.proposalStamp || reviewHeadSha != pr.headSha else { return }
        if reviewPRID == pr.id, reviewHeadSha != pr.headSha, details[pr.id]?.headSha != pr.headSha {
            // A new head can come with a new recorded base (a rebase): fetch the detail again. A detail
            // already for this head (it is what noticed the push) stays.
            details[pr.id] = nil
        }
        let samePR = reviewPRID == pr.id
        let sameHead = reviewHeadSha == pr.headSha
        reviewPRID = pr.id
        reviewProposalStamp = pr.proposalStamp
        reviewHeadSha = pr.headSha
        let next = ReviewModel(repo: URL(fileURLWithPath: path), options: DiffViewOptions())
        next.embedded = true
        // Only the proposal changed (a review landed, no push): the commit the reader picked still exists.
        if samePR, let previous = review, previous.repo.path == URL(fileURLWithPath: path).path, sameHead {
            next.scope = previous.scope
        } else {
            next.scope = Self.scope(pr, detail: details[pr.id], fetch: fetch)
        }
        if let fetch {
            // The main checkout is on another branch: file actions open the host's copy at the head.
            next.remoteHead = ReviewRemoteHead(branch: pr.headBranch, sha: fetch.head, base: fetch.mergeBase ?? fetch.base,
                                               hostURL: { path, line in pr.blobURL(fetch.head, path: path, line: line) })
        }
        // The PR's live threads on their lines, with reply / resolve / submit (`tools hub pr`): the store
        // `select` started with the detail when it is this PR's, so they are often in already.
        let target = Self.threadsTarget(pr, path: path)
        if let prefetched = prefetchedThreads, prefetched.target == target {
            next.attachPR(prefetched)
        } else {
            next.attachPR(target)
        }
        // The agent's drafts sit on the lines they are about, with accept / edit / reject.
        if let proposal = pr.proposal {
            do {
                // On the main thread: the file is read and parsed before the review shows.
                next.proposal = try HubPerf.measure("prs.proposal.read", proposal.path) {
                    try ProposalDocument(url: URL(fileURLWithPath: proposal.path))
                }
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

    /// Opens `pr`. The PR itself comes first: its detail (`tools hub pr show`), its live threads and,
    /// for a PR without a worktree, its head fetch all start at once and in parallel; the agent
    /// sessions follow the fresh detail. `opened`: a click, a link or the extension asked for it, so the
    /// detail is asked again even within the 15 s a list refresh re-selecting it waits.
    func select(_ pr: HubPR, opened: Bool = false) {
        // Another PR picked meanwhile: a reveal still waiting for the first one no longer applies.
        if let pending = pendingReveal, !pending.ref.matches(pr) {
            pendingReveal = nil
        }
        selectedID = pr.id
        let key = pr.id
        if details[key] == nil {
            // The last known detail, read off the main actor; the fresh one below replaces it and wins a race.
            Task {
                let cached = await Task.detached(priority: .userInitiated) { () -> HubPRDetail? in
                    PRListCache.readDetail(key).flatMap { try? JSONDecoder().decode(HubPRDetail.self, from: $0) }
                }.value
                if let cached, details[key] == nil {
                    details[key] = cached
                }
            }
        }
        loadDetail(pr, force: opened)
        prefetchThreads(pr)
        showDiff(pr)
    }

    /// Whether a `hub pr show` answer may move the row to its head. Only when the row still shows the head the
    /// request started from: a list that installed a newer head meanwhile is never rolled back by an older answer.
    nonisolated static func showMovesHead(started: String?, current: String?, shown: String?) -> Bool {
        guard let shown, shown != current else { return false }
        return current == started
    }

    /// Whether a `hub pr show` answer is older than the row: the list moved the head while it ran, and the
    /// answer names a head other than the one on screen now.
    nonisolated static func showIsStale(started: String?, current: String?, shown: String?) -> Bool {
        current != started && shown != nil && shown != current
    }

    /// The diff of `pr`: its worktree's, else its head fetched into the main checkout (`fetchHead`).
    private func showDiff(_ pr: HubPR) {
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
    }

    static func threadsTarget(_ pr: HubPR, path: String) -> PRTarget {
        .ref(pr.url.isEmpty ? "\(path)#\(pr.number)" : pr.url)
    }

    /// The selected PR's threads, asked for now rather than after its head fetch and diff load.
    /// `headMoved`: a push since the threads were read; the target (the PR URL) is the same, so the
    /// store on hand is asked again rather than kept with the old head's threads and line mappings.
    private func prefetchThreads(_ pr: HubPR, headMoved: Bool = false) {
        guard let path = pr.localWorktree ?? pr.repoRoot else {
            prefetchedThreads = nil
            return
        }
        let target = Self.threadsTarget(pr, path: path)
        if let current = prefetchedThreads, current.target == target {
            if headMoved {
                current.load(noCache: true)
            }
            return
        }
        if let review, review.pr?.target == target {
            prefetchedThreads = review.pr
            return
        }
        let store = PRThreadsStore(target: target)
        prefetchedThreads = store
        store.load()
    }

    /// `tools hub pr show` for `pr`, off the main thread. Opening a PR always asks again (the
    /// description, commits, checks and head move), at most once per 15 s unless `force`, so a list
    /// refresh re-selecting it does not spawn another. The agent sessions load after it.
    private func loadDetail(_ pr: HubPR, force: Bool) {
        let key = pr.id
        guard let root = pr.repoRoot, !detailLoading.contains(key),
              force || detailFetched[key].map({ Date().timeIntervalSince($0) > 15 }) ?? true else {
            if let detail = details[key] {
                sessions.load(pr, detail: detail)
            }
            return
        }
        detailLoading.insert(key)
        Task {
            let span = HubPerf.begin("prs.show", key, awaits: true)
            let fresh = await Task.detached(priority: .userInitiated) { () -> (HubPRDetail, HubPR?, Data)? in
                guard let data = try? ToolsCLIRunner.run(["hub", "pr", "show", "\(root)#\(pr.number)"]),
                      let detail = try? JSONDecoder().decode(HubPRDetail.self, from: data) else { return nil }
                return (detail, try? JSONDecoder().decode(HubPR.self, from: data), data)
            }.value
            span.end(fresh == nil ? "failed" : "")
            detailLoading.remove(key)
            guard let (detail, row, data) = fresh else {
                if let detail = details[key] {
                    sessions.load(pr, detail: detail)
                }
                return
            }
            let current = prs.first { $0.id == key } ?? pr
            // The list installed a newer head while this show ran, and the show answered another one: its
            // detail (commits, checks, base) belongs to an older observation. Nothing of it is installed;
            // the detail is asked again for the head on screen.
            if Self.showIsStale(started: pr.headSha, current: current.headSha, shown: row?.headSha) {
                HubPerf.log("prs.show \(pr.label) answered head \(row?.headSha?.prefix(10) ?? "-") after the list moved to \(current.headSha?.prefix(10) ?? "-"): discarded")
                loadDetail(current, force: true)
                return
            }
            detailFetched[key] = Date()
            Task.detached(priority: .utility) { PRListCache.writeDetail(data, id: key) }
            let previous = details[key]
            if previous != detail {
                details[key] = detail
            }
            if let row, row.id == key, Self.showMovesHead(started: pr.headSha, current: current.headSha, shown: row.headSha) {
                let head = row.headSha ?? ""
                // Pushed since the list answered (a force push): the row, its diff and its threads
                // follow the head the host has now, instead of keeping the old numbers on screen.
                HubPerf.log("prs.show \(pr.label) head moved \(current.headSha?.prefix(10) ?? "-") -> \(head.prefix(10)): row and diff follow")
                if let index = prs.firstIndex(where: { $0.id == key }) {
                    prs[index] = row
                }
                if selectedID == key {
                    prefetchThreads(row, headMoved: true)
                    showDiff(row)
                }
            } else if reviewPRID == key, detail.baseSha != nil, previous?.baseSha != detail.baseSha {
                review?.setScope(Self.scope(current, detail: detail, fetch: fetchedHead(current)))
            }
            sessions.load(prs.first { $0.id == key } ?? current, detail: detail)
        }
    }

    /// Selects the PR `id` names when the list has it (a `#n` link in a description); false otherwise.
    @discardableResult
    func open(id: String) -> Bool {
        guard let pr = prs.first(where: { $0.id == id }) else { return false }
        select(pr, opened: true)
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
    @ObservedObject private var readiness = PRReadinessStore.shared

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
                .instantTooltip(prs.showingCache ? "Showing the last known list; asking the forge for the current one" : "Loading the PR/MR list")
        }
        HubNotifyButton(prs: prs)
        IconButton(systemName: "arrow.clockwise", tooltip: "Reload the PR/MR list") { prs.reload() }
    }

    /// One group per project (`HubPR.project`): two checkouts named `service` from different origins
    /// stay apart. The folder name is only the title.
    private var groups: [(project: String, repo: String, rows: [HubPR])] {
        let query = PRQuery(model.filter)
        let rows = prs.prs.filter { pr in
            (!prs.mineOnly || pr.isMine == true) && (query.isEmpty || query.matches(pr))
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
                NoticePill(text: error, isError: true) { prs.dismissError(error) }
                    .padding(.horizontal, 10)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                    if prs.prs.isEmpty, prs.loading {
                        SkeletonRows(count: 10, leading: .dot)
                            .skeletonShimmer()
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Loading PRs and MRs")
                    }
                    ForEach(groups, id: \.project) { group in
                        Section {
                            if !prefs.collapsed.contains(group.project) {
                                ForEach(group.rows) { pr in
                                    row(pr)
                                        .transition(SWR.rowTransition)
                                }
                                if prs.fullProjects.contains(group.project) {
                                    let busy = prs.projectLoading.contains(group.project)
                                    GhostButton(
                                        busy ? "Loading…" : "Load \(PRsModel.pageSize) more",
                                        symbol: "arrow.down.circle",
                                        tooltip: "Ask \(group.repo) for \(PRsModel.pageSize) more PRs/MRs",
                                        fullWidth: true
                                    ) {
                                        prs.loadMore(project: group.project)
                                    }
                                    .disabled(busy)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                }
                            }
                        } header: {
                            GroupHeader(
                                title: group.repo,
                                count: group.rows.count,
                                prefs: prefs,
                                allNames: groups.map(\.project),
                                path: group.rows.first?.repoRoot,
                                key: group.project,
                                starred: true,
                                remove: prs.isRemovable(group.project) ? { prs.removeProject(group.project) } : nil
                            )
                        }
                    }
                    moreProjects(shown: Set(groups.map(\.project)))
                }
                .padding(.bottom, 12)
            }
        }
        // The list's own layout width: a sidebar drag that re-lays it out per step flips this per step.
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { HubBench.note("prs.list.width", Int($0)) }
        .onAppear {
            prs.search(model.filter)
            prs.refreshIfStale()
        }
        .onChange(of: model.filter) { _, filter in prs.search(filter) }
    }

    @State private var moreOpen = false

    /// Every other project cloned under the repo roots, folded under one header: a click loads its
    /// PRs into the list, the star keeps it there on every load. The sidebar filter narrows it by name.
    @ViewBuilder
    private func moreProjects(shown: Set<String>) -> some View {
        let needle = model.filter.trimmed.lowercased()
        let others = prs.allProjects.filter { project in
            !shown.contains(project.project) && (needle.isEmpty || project.repo.lowercased().contains(needle) || project.project.lowercased().contains(needle))
        }
        if !others.isEmpty {
            Section {
                if moreOpen || !needle.isEmpty {
                    ForEach(others) { project in
                        moreProjectRow(project)
                    }
                }
            } header: {
                Button { moreOpen.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(moreOpen || !needle.isEmpty ? 90 : 0))
                        Text("More projects").font(.system(size: 11.5, weight: .semibold))
                        Spacer()
                        Text(verbatim: "\(others.count)").font(.system(size: 10.5, design: .monospaced))
                    }
                    .foregroundColor(ReviewPalette.dim)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(ReviewPalette.sidebar)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Every other GitHub/GitLab project cloned under the repo roots; click one to load its PRs/MRs")
            }
        }
    }

    private func moreProjectRow(_ project: HubPRProject) -> some View {
        let starred = prefs.pinned.contains(project.project)
        return HStack(spacing: 6) {
            IconButton(systemName: starred ? "star.fill" : "star", tooltip: starred ? "Unstar \(project.repo)" : "Star \(project.repo): its PRs/MRs load with every list", size: 10) {
                prefs.togglePin(project.project)
                if !starred {
                    prs.loadProject(project)
                }
            }
            Button { prs.loadProject(project) } label: {
                HStack(spacing: 6) {
                    Text(project.repo).font(.system(size: 12)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1)
                    Text(project.project.replacingOccurrences(of: "https://", with: ""))
                        .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    if prs.projectLoading.contains(project.project) {
                        ProgressView().controlSize(.mini)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Load \(project.repo)'s PRs/MRs (\(project.root))")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
    }

    private func row(_ pr: HubPR) -> some View {
        let selected = prs.selectedID == pr.id
        // The badges sit at the end of the meta line: as a right-hand column they took ~70 pt from a
        // title that already had ~150, so most titles read "feat(flexi, col-…".
        return HStack(alignment: .top, spacing: 8) {
            PRStateIcon(pr: pr)
            VStack(alignment: .leading, spacing: 3) {
                Text(pr.title)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.92))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // The author gives way first: whole, then truncated to at least a few letters, then
                // gone. Squeezed by the badges it read "q" or "c" (video 2026-09-30 14:07).
                metaLine(pr)
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        // New and updated rows after a refresh flash once.
        .swrFlash(prs.changed.contains(pr.id))
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 8) { prs.select(pr, opened: true) }
        .padding(.horizontal, 6)
        .instantTooltip("\(pr.label) \(pr.headBranch) → \(pr.baseBranch)\nRight-click for its web pages")
        // The row stays one button (select); its labels' web pages live here, since a link inside
        // the row would turn a click meant to select into a browser tab.
        .contextMenu { linksMenu(pr) }
    }

    private func metaLine(_ pr: HubPR) -> some View {
        PRMetaLineLayout {
            Text(verbatim: pr.label).font(.system(size: 11, design: .monospaced))
            // Flexible and clipped, so a zero width hides it instead of drawing an ellipsis.
            Text(verbatim: pr.author ?? "").truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .clipped()
            Text(verbatim: "·").frame(maxWidth: .infinity).clipped()
            // Whole, so the author truncates and the age never reads "4 hr. a…".
            LiveAgo(date: pr.updated, style: .brief)
            badges(pr)
        }
    }

    @ViewBuilder
    private func badges(_ pr: HubPR) -> some View {
        HStack(spacing: 5) {
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
            PRReadinessBadge(readiness: readiness.readiness(for: pr))
            CIBadge(ci: pr.ci)
        }
        .fixedSize()
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

/// A PR row's meta line from five subviews: label, author, "·", age, badges (at the trailing edge).
/// The author gives way first: whole, then truncated to at least `authorMinWidth`, then gone with its
/// dot. One pass per width over the children's ideal sizes. A `ViewThatFits` of three whole lines
/// measured every variant of every visible row on each step of a sidebar drag: busy p50 about 45 ms
/// per step (`--bench`, 2026-09-30).
struct PRMetaLineLayout: Layout {
    static let spacing: CGFloat = 5
    static let authorMinWidth: CGFloat = 48
    /// The least room between the age and the badges.
    static let badgeGap: CGFloat = 4

    /// Width of the label, author, dot, age and badges; 0 hides the author and its dot.
    static func widths(ideal: [CGFloat], width: CGFloat?) -> [CGFloat] {
        guard ideal.count == 5 else { return ideal }
        let (label, author, dot, age, badges) = (ideal[0], ideal[1], ideal[2], ideal[3], ideal[4])
        let bare = label + spacing + age + badgeGap + badges
        guard author > 0 else { return [label, 0, 0, age, badges] }
        guard let width else { return ideal }
        let room = width - bare - 2 * spacing - dot
        if room >= author { return ideal }
        if room >= min(authorMinWidth, author) { return [label, room, dot, age, badges] }
        return [label, 0, 0, age, badges]
    }

    private func plan(_ proposal: ProposedViewSize, _ subviews: Subviews) -> [CGFloat] {
        Self.widths(ideal: subviews.map { $0.sizeThatFits(.unspecified).width }, width: proposal.width)
    }

    private static func naturalWidth(_ widths: [CGFloat]) -> CGFloat {
        let shown = widths.enumerated().filter { $0.offset == 4 || $0.element > 0 }
        return shown.reduce(0) { $0 + $1.element } + CGFloat(max(0, shown.count - 2)) * spacing + badgeGap
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let widths = plan(proposal, subviews)
        let height = zip(subviews, widths).map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }.max() ?? 0
        return CGSize(width: proposal.width ?? Self.naturalWidth(widths), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let widths = plan(ProposedViewSize(width: bounds.width, height: proposal.height), subviews)
        var x = bounds.minX
        for (index, subview) in subviews.enumerated() {
            let width = index < widths.count ? widths[index] : 0
            let size = ProposedViewSize(width: width, height: nil)
            let height = subview.sizeThatFits(size).height
            if index == subviews.count - 1 {
                subview.place(at: CGPoint(x: bounds.maxX - width, y: bounds.midY - height / 2), proposal: size)
                continue
            }

            subview.place(at: CGPoint(x: x, y: bounds.midY - height / 2), proposal: size)
            if width > 0 { x += width + Self.spacing }
        }
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
            if prs.loading {
                PaneSkeleton("Loading PRs and MRs")
            } else {
                Text("Pick a PR or MR")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
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
                // release) instead of NSSplitView's bare divider. Both columns follow its drag at once
                // (no gap) and keep their content's size until release, their surface filling the rest:
                // reflowing them per step cost 13 to 15 ms of main thread per step, held 5 (`--bench`
                // overview, 2026-09-30).
                SideSplit(panelEdge: .leading, maxFraction: Self.overviewFraction) {
                    ResizableSidePanel(key: "prs.overview", edge: .leading, title: "PR", defaultWidth: 460,
                                       minWidth: Self.overviewMinWidth, maxWidth: max(Self.overviewMinWidth, room),
                                       autoCollapse: width > 0 && room < Self.overviewMinWidth,
                                       holdsLayout: false) {
                        overview.freezesWidthWhileResizing().hubSurface(.content)
                    }
                    ReviewRootView(model: review)
                        .freezesWidthWhileResizing()
                        .hubSurface(.content)
                }
                .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
            } else if showDiff, prs.fetchState(pr) == .fetching {
                // The head is on its way into the main checkout: the diff's place shows its shape.
                HStack(spacing: 0) {
                    overview
                        .frame(width: max(Self.overviewMinWidth, width * 0.4))
                        .hubSurface(.content)
                    Rectangle().fill(ReviewPalette.hairline).frame(width: 1)
                    DiffSkeleton()
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .hubSurface(.content)
                }
                .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
            } else {
                overview
            }
        }
    }

    /// The first row sits in the window's title bar (`TitlebarHeader`).
    private var header: some View {
        TitlebarHeader {
            HStack(spacing: 10) {
                // Where it lives first ("GitHub #436", a click opens it), then its title on one line.
                if let forge = Forge(kind: pr.origin?.kind) {
                    ForgeBadge(forge: forge, number: pr.number, url: URL(string: pr.url)) { ExternalOpener.open($0) }
                } else {
                    PRStateIcon(pr: pr)
                    ExternalLink(text: pr.label, url: URL(string: pr.url), font: .system(size: 13, weight: .semibold), color: Color(red: 0.62, green: 0.78, blue: 1))
                }
                Text(pr.title)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .instantTooltip(pr.title)
                    .contextMenu {
                        Button("Copy title") { Clipboard.copy(pr.title, what: "title") }
                        Button("Copy \(pr.label) and title") { Clipboard.copy("\(pr.label) \(pr.title)", what: "title") }
                    }
                    .layoutPriority(1)
                statePill
                CIBadge(ci: pr.ci, url: detail?.webUrls?.checks.flatMap(URL.init(string:)))
                PRReadinessHeaderChip(pr: pr)
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
        } details: {
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
                // A cached detail for another head (pushed since) would show its old numbers: they wait
                // for the fresh one, which `select` asks for on every open.
                if let detail, detail.headSha == nil || pr.headSha == nil || detail.headSha == pr.headSha {
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
    }

    /// Open / Draft / Merged / Closed in the same color as the state icon.
    private var statePill: some View {
        let tone = PRStateTone(pr: pr)
        return Badge(tone.title, color: tone.color, look: .tone, tooltip: "\(pr.isGitLab ? "MR" : "PR") state: \(tone.title)")
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
                .hoverCursor(.pointingHand)
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

    /// The description with its links, made once per body and link context (`PRDescriptionCache`).
    private func linkedDescription(_ body: String) -> String {
        let siblings = prs.prs.filter { $0.project == pr.project }.map { "\($0.number)\($0.isGitLab ? "!" : "#")\($0.headBranch)>\($0.baseBranch)" }
        let key = [pr.id, body, (detail?.branchMentions ?? []).joined(separator: " "), siblings.sorted().joined(separator: " ")]
            .joined(separator: "\u{1}")
        return PRDescriptionCache.linked(key: key) { PRDescriptionLinker.linkify(body, context: linkContext) }
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
            // The PR first (description, commits, checks), the agent sessions that touched it after.
            LazyVStack(alignment: .leading, spacing: 0) {
                if let body = detail?.body?.trimmed, !body.isEmpty {
                    PRSection(title: "Description", folded: $foldDescription) {
                        MarkdownContentView(markdown: linkedDescription(body))
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
                    SkeletonLines(count: 6)
                        .skeletonShimmer()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Loading the description")
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
                PRSessionsSection(model: model, prs: prs, store: prs.sessions, pr: pr, folded: $foldSessions)
                    .id(Self.sessionsID)
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

    /// Description, commits, checks and sessions, in the order the overview shows them.
    private func findRows() -> [PanelFindRow] {
        var rows: [PanelFindRow] = []
        if let body = detail?.body?.trimmed, !body.isEmpty {
            let markdown = linkedDescription(body)
            rows.append(PanelFindRow(id: Self.descriptionID, fields: [PanelFindField("desc", markdown, markdown: true)], container: Self.descriptionSectionID))
        }
        rows += (detail?.commits ?? []).reversed().map(PRCommitRow.searchable)
        rows += PRChecksSection.sorted(detail?.checks ?? []).map { check in
            PanelFindRow(id: "check:\(check.id)", fields: [PanelFindField("link", check.name)], container: Self.checksID)
        }
        rows += PRSessionsSection.rows(model: model, store: prs.sessions, pr: pr).map { row in
            PanelFindRow(id: "session:\(row.id)", fields: [PanelFindField("title", row.session.displayTitle)], container: Self.sessionsID)
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

/// Linked PR descriptions by PR, body and link context. The linker runs its regexes over every line,
/// and the overview's body runs on every step of a sidebar drag (`sample`, 2026-09-30).
@MainActor
enum PRDescriptionCache {
    private static var linked: [String: String] = [:]

    static func linked(key: String, make: () -> String) -> String {
        if let known = linked[key] { return known }
        if linked.count >= 64 { linked.removeAll() }
        let value = make()
        linked[key] = value
        return value
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
                LiveAgo(date: commit.when)
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
                // A fixed slot, so the reload button beside it stays put.
                ZStack {
                    if loading {
                        ProgressView().controlSize(.mini)
                    }
                }
                .frame(width: 12, height: 12)
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
                    .textSelection(.enabled)
                    .instantTooltip(error)
            }
        }
    }

    private func emptyText(loading: Bool) -> String {
        if loading { return "Looking through the agent sessions…" }
        if pr.repoRoot == nil { return "No local checkout of this project, so no session can be matched." }
        return "No session worked on this branch, its commits or its files."
    }
}
