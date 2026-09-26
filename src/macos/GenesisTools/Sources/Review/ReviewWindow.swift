import AppKit
import CoreServices
import SwiftUI
import WebKit

// GenesisTools --review [--repo <path>] [--session <id>] [--scope uncommitted|unstaged|staged|branch]
//                       [--style split|unified] [--snapshot <png>]
//
// The per-session review window. v1 shows a repository's working tree against HEAD; the session
// change log (handoff h_p38uwgeo) becomes a second source behind the same model. `--snapshot`
// renders once, writes a PNG of the window and exits, so a change can be checked without a screen.

func runReview(_ args: [String]) -> Never {
    var repoPath = FileManager.default.currentDirectoryPath
    var snapshotPath: String?
    var session: String?
    var scope = DiffScope.uncommitted
    var proposalPath: String?
    var options = DiffViewOptions()
    var activate = true
    var demo = ReviewSnapshotDemo()
    var index = 0
    while index < args.count {
        let value = index + 1 < args.count ? args[index + 1] : nil
        switch args[index] {
        case "--repo": repoPath = value ?? repoPath; index += 1
        case "--snapshot": snapshotPath = value; index += 1
        case "--keys": demo.keys = true
        case "--select-open": demo.selectOpen = Int(value ?? "") ?? 3; index += 1
        case "--step-threads": demo.steps = Int(value ?? "") ?? 1; index += 1
        case "--reply": demo.reply = true
        case "--toggle": demo.toggle = true
        case "--loading": demo.loading = true
        case "--fix-form": demo.fixForm = true
        case "--blame": demo.blame = ReviewSnapshotDemo.blameTarget(value); index += 1
        case "--session": session = value; index += 1
        case "--scope": scope = DiffScope(argument: value ?? "") ?? .uncommitted; index += 1
        case "--proposal": proposalPath = value; index += 1
        case "--no-activate": activate = false
        case "--style": options.diffStyle = DiffViewOptions.Style(rawValue: value ?? "") ?? .split; index += 1
        default: break
        }
        index += 1
    }

    let app = NSApplication.shared
    // A snapshot run must never become the active app: it would take the keystrokes of whoever is typing.
    app.setActivationPolicy(snapshotPath == nil ? .regular : .prohibited)
    let delegate = ReviewAppDelegate()
    app.delegate = delegate
    installBrowserURLForwarder()
    MainActor.assumeIsolated { AppMainMenu.install() }

    var proposal: ProposalDocument?
    if let proposalPath {
        do {
            let document = try ProposalDocument(url: URL(fileURLWithPath: proposalPath))
            repoPath = document.repoPath ?? repoPath
            scope = .range(base: document.baseSha, head: document.headSha, label: "\(document.label) \(document.title.prefix(40))")
            proposal = document
        } catch {
            FileHandle.standardError.write(Data("review: cannot read proposal \(proposalPath): \(error)\n".utf8))
            exit(1)
        }
    }

    let model = ReviewModel(repo: URL(fileURLWithPath: repoPath).standardizedFileURL, options: options, session: session)
    model.scope = scope
    model.proposal = proposal
    if let target = proposal?.prTarget {
        model.attachPR(target)
    }
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
        styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    window.title = "Review · \(model.repo.lastPathComponent)"
    window.titlebarAppearsTransparent = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = ReviewPalette.background
    window.contentView = NSHostingView(rootView: ReviewRootView(model: model))
    window.center()
    window.setFrameAutosaveName("GenesisToolsReview")
    delegate.window = window

    if let snapshotPath {
        model.onFirstRender = {
            demo.apply(to: model) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    ReviewSnapshot.write(window: window, webView: (model.renderer as? PierreWebDiffRenderer)?.webView, to: snapshotPath) {
                        exit(0)
                    }
                }
            }
        }
        // A snapshot run must end even if the page never renders.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            FileHandle.standardError.write(Data("review snapshot: no render within 30 s\n".utf8))
            exit(1)
        }
        window.orderInForSnapshot()
    } else {
        window.makeKeyAndOrderFront(nil)
        if activate {
            app.activate(ignoringOtherApps: true)
        }
    }

    MainActor.assumeIsolated { HangWatch.start() }
    model.start()
    app.run()
    exit(0)
}

private final class ReviewAppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

enum ReviewPalette {
    static let background = NSColor(srgbRed: 0.075, green: 0.075, blue: 0.08, alpha: 1)
    static let sidebar = Color(nsColor: NSColor(srgbRed: 0.095, green: 0.095, blue: 0.1, alpha: 1))
    static let hairline = Color.white.opacity(0.08)
    static let added = Color(red: 0.36, green: 0.80, blue: 0.47)
    static let removed = Color(red: 0.96, green: 0.38, blue: 0.40)
    static let modified = Color(red: 0.98, green: 0.66, blue: 0.25)
    static let renamed = Color(red: 0.45, green: 0.62, blue: 0.98)
    static let dim = Color.white.opacity(0.5)

    static func color(_ status: DiffFile.Status) -> Color {
        switch status {
        case .added: return added
        case .deleted: return removed
        case .modified: return modified
        case .renamed: return renamed
        }
    }
}

// MARK: - Model

final class ReviewModel: ObservableObject {
    let repo: URL
    let renderer: DiffRenderer
    let comments: ReviewCommentStore
    /// The agent session this review is for; "Send to agent" types into its cmux pane.
    let session: String?
    var onFirstRender: (() -> Void)?

    @Published var branch = ""
    @Published var base: String?
    @Published var scope = DiffScope.uncommitted
    @Published var commits: [RepoCommit] = []
    /// An agent's review proposal shown on this diff (drafts + meta), when opened with --proposal.
    @Published var proposal: ProposalDocument?
    /// The PR/MR this diff belongs to, with its live review threads; nil for a plain working-tree diff.
    @Published private(set) var pr: PRThreadsStore?
    /// Inside the hub the header is not next to the traffic lights, so it needs no leading inset.
    var embedded = false
    /// Set when no checkout on disk holds the diff's head (a PR without a worktree, its head fetched
    /// into `repo`): this repository's files open on the host at that head (Review/ReviewRemoteHead.swift).
    var remoteHead: ReviewRemoteHead?
    @Published var files: [DiffFile] = []
    /// The file list's filter text; the list's rows are rebuilt from it in the view.
    @Published var filter = "" {
        didSet {
            if filter != oldValue {
                MainActor.assumeIsolated { HubMainBusy.measure("review.files.filter") }
            }
        }
    }
    @Published var selectedID: String?
    @Published var options: DiffViewOptions
    @Published var error: String?
    @Published var loading = false
    @Published var lastLoaded: Date?
    @Published var commentCount = 0
    @Published var unsentCount = 0
    @Published var notice: String?
    @Published var treeMode = true {
        didSet { MainActor.assumeIsolated { HubMainBusy.measure("review.files.tree") } }
    }
    @Published var collapsed: Set<String> = []
    /// Set only when the diff moves to a file on its own (a find match), so a click in the list never scrolls the list.
    @Published var sidebarScrollTarget: String?
    /// PR thread ids picked for "Fix threads": the cards' Fix checkboxes, the threads list, and x.
    @Published var selectedThreads: Set<String> = [] {
        didSet {
            if selectedThreads != oldValue {
                renderer.setThreadSelection(selectedThreads.sorted())
            }
        }
    }
    /// The thread card j / k moved to; r, e and x act on it.
    @Published private(set) var focusedCard: String?
    /// Bumped by s and f: the PR bar opens Submit review / Fix threads (each still asks first).
    @Published var submitRequests = 0
    @Published var fixRequests = 0
    /// A `--snapshot --fix-form` run shows the Fix form under the PR bar instead of in a popover.
    @Published var showsFixFormInline = false
    /// The live thread cards on the diff in page order, for j / k.
    private var threadCards: [RenderedComment] = []
    /// `tools agents blame` for the files hovered so far: the page's hover tips, and "Open the turn".
    private var blame = AgentBlameState()
    /// File ids the page asked about and no call has answered yet; one call runs at a time.
    private var blamePending: Set<String> = []
    private var blameRunning: Set<String> = []
    /// Bumped when the file set changes: an answer for the old files is dropped.
    private var blameGeneration = 0

    /// The repositories this diff shows (Review/ReviewRoots.swift). The first is `repo`; the hub adds
    /// the session's ticked folders, and then every file sits under its root's folder name.
    @Published private(set) var roots: [ReviewRoot]
    /// The Files tree's root rows: tick or untick a root, or remove an added folder. Set by the hub.
    var rootActions: ReviewRootActions?
    /// Comments of the other roots, each anchored in its own repository (`comments` is `repo`'s).
    private var rootComments: [String: ReviewCommentStore] = [:]

    private var watchers: [RepoWatcher] = []
    private var started = false
    private var loadInFlight = false
    private var reloadAgain = false
    /// Root folders whose files changed since the last load started; the next load reads only these.
    private var pendingLoads: Set<String> = []
    private var rendered = false
    /// A file asked for by `reveal(path:)` before the diff had it.
    private var pendingRevealPath: String?
    /// A PR thread's card asked for by `reveal(path:thread:)` before the page showed it.
    private var pendingThreadCard: String?
    /// When the last file set went to the renderer; `.rendered` closes the span.
    private var renderStart: CFAbsoluteTime?
    private let createdAt = CFAbsoluteTimeGetCurrent()

    init(repo: URL, options: DiffViewOptions, session: String? = nil, renderer: DiffRenderer = PierreWebDiffRenderer()) {
        self.repo = repo
        self.options = options
        self.session = session
        self.renderer = renderer
        comments = ReviewCommentStore(repo: repo)
        roots = [ReviewRoot(folder: repo.path, repo: repo)]
        renderer.onEvent = { [weak self] event in
            self?.handle(event)
        }
        renderer.apply(options)
    }

    /// What an empty diff says: a turns scope waits for the next turn instead of calling itself clean.
    var emptyMessage: String {
        switch scope {
        case .lastTurns(let count):
            return count == 1
                ? "The last turn changed no files in this repository.\nThis panel follows the next turn."
                : "The last \(count) turns changed no files in this repository.\nThis panel follows the next turn."
        case .uncommitted: return "No changes against HEAD"
        default: return "No changes in \(scope.title)"
        }
    }

    var totals: (additions: Int, deletions: Int) {
        files.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
    }

    var filteredFiles: [DiffFile] {
        let needle = filter.trimmed.lowercased()
        guard !needle.isEmpty else { return files }
        return files.filter { $0.path.lowercased().contains(needle) }
    }

    var selectedIndex: Int? {
        files.firstIndex { $0.id == selectedID }
    }

    /// Starts loading and watching. Idempotent; the view calls it on appear and `stop()` on
    /// disappear, so a hidden review (a hub tab not shown) neither watches nor reloads.
    func start() {
        guard !started else { return }
        started = true
        reload()
        if let pr, pr.payload == nil, !pr.loading {
            pr.load()
        }
        watchRoots()
    }

    func stop() {
        started = false
        watchers = []
    }

    private func watchRoots() {
        watchers = roots.filter(\.shown).compactMap { root in
            root.repo.map { repo in
                RepoWatcher(root: repo) { [weak self] in
                    self?.reload(folders: [root.folder])
                }
            }
        }
    }

    // MARK: Roots

    /// The hub's roots for this diff: this repository first, then the session's added folders. The
    /// same roots again changes nothing; otherwise the tree and the diff change at once (an unticked
    /// root's files go) and the shown roots load again.
    func setRoots(_ wanted: [ReviewRoot]) {
        var next = wanted.isEmpty ? [ReviewRoot(folder: repo.path, repo: repo)] : wanted
        let names = ReviewRoots.prefixes(for: next.map { $0.repo?.path ?? $0.folder })
        for index in next.indices {
            next[index].prefix = next.count > 1 ? names[index] : ""
            if next[index].repo == nil {
                next[index].error = next[index].error ?? "Not inside a git repository, so its changes cannot be listed."
            } else if let old = roots.first(where: { $0.folder == next[index].folder && $0.repo == next[index].repo }), next[index].shown {
                next[index].files = old.files
                next[index].branch = old.branch
                next[index].error = old.error
            }
        }
        guard next.count != roots.count || zip(next, roots).contains(where: { !$0.sameSetup(as: $1) }) else { return }

        HubPerf.log("review.roots \(next.map { "\($0.prefix.isEmpty ? $0.folder : $0.prefix)\($0.shown ? "" : " (hidden)")" }.joined(separator: ", "))")
        roots = next
        let merged = ReviewRoots.merge(roots)
        if merged != files {
            files = merged
            if selectedID == nil || !files.contains(where: { $0.id == selectedID }) {
                selectedID = files.first?.id
            }
            pushToRenderer()
            resetBlame()
        }
        if started {
            watchRoots()
            reload()
        }
    }

    /// The comment store of a root: `comments` for this repository, one per other repository.
    private func commentStore(for root: ReviewRoot) -> ReviewCommentStore? {
        guard let path = root.repo?.path else { return nil }
        if path == repo.path {
            return comments
        }
        if let store = rootComments[path] {
            return store
        }
        let store = ReviewCommentStore(repo: URL(fileURLWithPath: path))
        rootComments[path] = store
        return store
    }

    /// The shown roots with their comment stores, in root order.
    private var commentRoots: [(root: ReviewRoot, store: ReviewCommentStore)] {
        roots.filter(\.shown).compactMap { root in commentStore(for: root).map { (root, $0) } }
    }

    /// The root and store that hold a local comment.
    private func commentOwner(_ id: String) -> (root: ReviewRoot, store: ReviewCommentStore)? {
        if let owner = commentRoots.first(where: { $0.store.comments.contains { $0.id == id } }) {
            return owner
        }
        return comments.comments.contains { $0.id == id } ? (primaryRoot, comments) : nil
    }

    /// This repository's root: PR threads and proposal drafts belong to it alone.
    private var primaryRoot: ReviewRoot {
        roots.first { $0.repo?.path == repo.path } ?? roots[0]
    }

    /// A merged file id's root, and the file as its repository names it.
    func locate(fileID: String) -> (root: ReviewRoot, file: DiffFile)? {
        guard let index = ReviewRoots.index(of: fileID, in: roots), let local = roots[index].local(fileID),
              let file = roots[index].files.first(where: { $0.id == local }) else { return nil }
        return (roots[index], file)
    }

    /// The file on disk: its root's repository plus its repo-relative path. Nil for this repository's
    /// files under `remoteHead`: the copy on disk belongs to another branch.
    func absolutePath(of file: DiffFile) -> String? {
        guard let found = locate(fileID: file.id), let root = found.root.repo else { return nil }
        if remoteHead != nil, root.path == repo.path { return nil }
        return root.appendingPathComponent(found.file.path).path
    }

    /// The host's copy of this repository's file at `remoteHead`, at a line when given; nil otherwise.
    func hostURL(of fileID: String, line: Int? = nil) -> URL? {
        guard let remoteHead, let found = locate(fileID: fileID), found.root.repo?.path == repo.path else { return nil }
        return remoteHead.hostURL(found.file.path, line)
    }

    /// The repo-relative path of a merged file, for PR threads (which name paths in this repository).
    func repoPath(of fileID: String?) -> String? {
        fileID.flatMap { locate(fileID: $0) }.map(\.file.path)
    }

    /// A file by an absolute path inside any root, or by a path relative to this repository.
    func file(atPath path: String) -> DiffFile? {
        let wanted = ReviewRoots.global(path: path, in: roots)
        return files.first { $0.path == wanted || $0.oldPath == wanted }
    }

    /// The diff belongs to this PR/MR: its live threads load now (or on `start`) and sit on their lines.
    func attachPR(_ target: PRTarget) {
        guard pr?.target != target else { return }
        let store = PRThreadsStore(target: target)
        store.onChange = { [weak self] in
            self?.pushComments()
        }
        pr = store
        if started {
            store.load()
        }
    }

    /// "#424" / "!12", from the proposal or the loaded threads.
    /// While the threads load, the number comes from the branch facts the header already fetched.
    /// Read on the main thread only (views, alerts), so the store read assumes the main actor.
    var prLabel: String {
        if let label = proposal?.label ?? pr?.payload?.pr.identity.label {
            return label
        }
        let path = repo.path
        if let facts = MainActor.assumeIsolated({ RepoFactsStore.shared.facts(for: path, pr: true) }), let pull = facts.pr {
            return facts.origin?.kind == "gitlab" ? "!\(pull.number)" : "#\(pull.number)"
        }
        return "the PR"
    }

    private var prIdentity: PRIdentity? {
        if let proposal, proposal.number > 0, !proposal.project.isEmpty {
            return proposal.identity
        }
        return pr?.payload?.pr.identity
    }

    /// Live threads sit on the lines of the PR's head, so they go on the diff only when it compares
    /// against a base (the PR's range, or the branch); the threads list shows them in every scope.
    var showsLiveThreadsInline: Bool {
        switch scope {
        case .branch, .range: return true
        default: return false
        }
    }

    /// Loads every shown root again (a new scope, new roots, the refresh button).
    func reload() {
        reload(folders: Set(roots.filter(\.shown).map(\.folder)))
    }

    /// One load at a time: events that arrive during a load collapse into one follow-up load of the
    /// roots they named. A file event reloads only its own root, so an agent writing in one repository
    /// does not re-read the others.
    private func reload(folders: Set<String>) {
        pendingLoads.formUnion(folders)
        if loadInFlight {
            reloadAgain = true
            return
        }

        let wanted = pendingLoads
        pendingLoads = []
        // Every wanted root in parallel, each in its own span. A commit or a range names commits of this
        // repository only, so the other roots have nothing for it.
        let jobs = roots.filter { $0.shown && wanted.contains($0.folder) }.compactMap { root in root.repo.map { (folder: root.folder, repo: $0) } }
        guard !jobs.isEmpty else {
            loading = false
            return
        }

        loadInFlight = true
        loading = true
        let scope = scope
        let session = session
        let primary = repo
        let commitRange = remoteHead?.commitRange
        let onlyPrimary: Bool
        switch scope {
        case .commit, .range: onlyPrimary = true
        default: onlyPrimary = false
        }
        let loadsPrimary = jobs.contains { $0.repo.path == primary.path }
        let namesRoot = roots.count > 1
        DispatchQueue.global(qos: .userInitiated).async {
            let lock = NSLock()
            var results: [String: Result<GitWorkingTreeSource.Snapshot, Error>] = [:]
            DispatchQueue.concurrentPerform(iterations: jobs.count) { index in
                let job = jobs[index]
                let result: Result<GitWorkingTreeSource.Snapshot, Error>
                if onlyPrimary && job.repo.path != primary.path {
                    result = .success(GitWorkingTreeSource.Snapshot(branch: "", base: nil, files: []))
                } else {
                    let span = HubPerf.begin("review.load", namesRoot ? "\(scope) \(job.repo.lastPathComponent)" : "\(scope)")
                    result = Result { try GitWorkingTreeSource(repo: job.repo).load(scope: scope, session: session) }
                    span.end()
                }
                lock.lock()
                results[job.folder] = result
                lock.unlock()
            }
            let commits = loadsPrimary ? GitWorkingTreeSource(repo: primary).commits(range: commitRange) : nil
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if let commits {
                    self.commits = commits
                }
                self.loadInFlight = false
                // Answers for another scope are dropped (the scope menu changed during the load), and so
                // are answers that the next load replaces anyway; the rest are kept, since a follow-up
                // load may name other roots only.
                let superseded = self.reloadAgain && Set(results.keys).isSubset(of: self.pendingLoads)
                if scope == self.scope, !superseded {
                    self.lastLoaded = Date()
                    self.apply(results)
                }
                if self.reloadAgain {
                    self.reloadAgain = false
                    self.reload(folders: [])
                } else {
                    self.loading = false
                }
            }
        }
    }

    /// One load's answers, per root folder. A failed root keeps its last files and shows the error on
    /// its folder row; only a single-root diff shows it over the whole pane.
    @MainActor
    private func apply(_ results: [String: Result<GitWorkingTreeSource.Snapshot, Error>]) {
        var next = roots
        for index in next.indices {
            guard let result = results[next[index].folder] else { continue }
            switch result {
            case .success(let snapshot):
                next[index].error = nil
                next[index].files = snapshot.files
                next[index].branch = snapshot.branch
                if next[index].repo?.path == repo.path {
                    if branch != snapshot.branch {
                        RepoFactsStore.shared.invalidate(repo.path)
                    }
                    branch = snapshot.branch
                    base = snapshot.base
                }
                commentStore(for: next[index])?.reanchor(files: snapshot.files)
            case .failure(let failure):
                next[index].error = "\(failure)"
                HubPerf.log("review.load \(next[index].folder) failed: \(failure)")
            }
        }
        if next != roots {
            roots = next
        }
        error = roots.count == 1 ? roots[0].error : nil

        let merged = ReviewRoots.merge(roots)
        let changed = merged != files
        files = merged
        if let pending = pendingRevealPath, let file = file(atPath: pending) {
            pendingRevealPath = nil
            selectedID = file.id
        }
        if selectedID == nil || !files.contains(where: { $0.id == selectedID }) {
            selectedID = files.first?.id
        }
        if changed || !rendered {
            pushToRenderer()
            resetBlame()
        } else {
            pushComments()
        }
    }

    /// Opens a file now or once the next load has it: an absolute path inside any root, or a path
    /// relative to this repository.
    func reveal(path: String) {
        if let file = file(atPath: path) {
            select(file.id)
        } else {
            pendingRevealPath = path
            notice = files.isEmpty ? nil : "\((path as NSString).lastPathComponent) has no change in this scope."
        }
    }

    /// The file, then the PR thread's card on its line once the diff and the PR's threads are on the
    /// page (an outdated thread has no card: the file alone opens).
    func reveal(path: String, thread threadID: String?) {
        reveal(path: path)
        pendingThreadCard = threadID.map { PRThreadRendering.cardID(thread: $0) }
        focusPendingThread()
    }

    private func focusPendingThread() {
        guard let pending = pendingThreadCard else { return }
        guard let card = Self.cardToFocus(pending, rendered: rendered, cards: threadCards) else {
            HubPerf.log("review.reveal-thread \(pending) waits: rendered=\(rendered) cards=\(threadCards.count)")
            return
        }
        pendingThreadCard = nil
        focusedCard = card
        HubPerf.log("review.reveal-thread \(card) focused")
        renderer.focusThread(cardID: card, reply: false)
    }

    /// The pending card, once the page has drawn the diff and holds that card; nil until then.
    static func cardToFocus(_ pending: String?, rendered: Bool, cards: [RenderedComment]) -> String? {
        guard let pending, rendered, cards.contains(where: { $0.id == pending }) else { return nil }
        return pending
    }

    func select(_ id: String) {
        selectedID = id
        if showsOneFile {
            pushToRenderer()
        } else {
            renderer.reveal(fileID: id)
        }
    }

    /// Find in every file of the diff: the page searches its parsed diffs, not what is on screen.
    func find() {
        renderer.find()
    }

    func setScope(_ next: DiffScope) {
        guard next != scope else { return }
        scope = next
        files = []
        for index in roots.indices {
            roots[index].files = []
        }
        rendered = false
        reload()
    }

    func setStyle(_ style: DiffViewOptions.Style) {
        options.diffStyle = style
        renderer.apply(options)
    }

    func toggleWrap() {
        options.wrap.toggle()
        renderer.apply(options)
    }

    func stepFont(_ delta: Double) {
        options.fontSize = max(10, min(20, options.fontSize + delta))
        renderer.apply(options)
    }

    /// Render only the selected file. A `--snapshot --file` sets it: in a window nobody sees, WebKit
    /// paints no frame for a file that is only scrolled into view.
    var showsOneFile = false

    /// Every file goes to the renderer, however large the diff: it lays out only what is near the
    /// viewport. A new scope starts at the top; a refresh of the same diff keeps the scroll position.
    private func pushToRenderer() {
        renderStart = PerfLog.now()
        pushComments()
        if showsOneFile, let index = selectedIndex {
            renderer.show([files[index]], fresh: true)
        } else {
            renderer.show(files, fresh: !rendered)
        }
    }

    /// Each root's comments on its own files, and the PR's threads and proposal on this repository's;
    /// every file id then goes under its root's prefix.
    private func pushComments() {
        let primary = primaryRoot
        let prFiles = primary.shown ? primary.files : []
        let live = pr?.payload?.threads ?? []
        let proposalComments = PRThreadRendering.refresh(proposal?.rendered(for: prFiles) ?? [], with: live, forge: pr?.payload?.pr.forge)
        let shown = Set(proposal?.threads.map(\.id) ?? [])
        let liveComments = showsLiveThreadsInline ? PRThreadRendering.rendered(live, files: prFiles, skip: shown, forge: pr?.payload?.pr.forge) : []
        if !live.isEmpty {
            HubPerf.log("review.prThreads \(live.count) live, \(liveComments.count) on this diff (\(files.count) files, scope \(scope.title))")
        }
        let owned = commentRoots
        let local = owned.flatMap { root, store in Self.globalized(store.rendered(for: root.files), root) }
        let all = local + Self.globalized(proposalComments + liveComments, primary)
        renderer.showComments(all)
        threadCards = ReviewKeyNav.threadCards(all, files: files)
        if let focusedCard, !threadCards.contains(where: { $0.id == focusedCard }) {
            self.focusedCard = nil
            // The page keeps its own mark: without this, a card that comes back (a scope switch and
            // back) shows the mark while e and x say there is none.
            renderer.focusThread(cardID: nil, reply: false)
        }
        focusPendingThread()
        commentCount = owned.reduce(0) { $0 + $1.store.comments.count }
        unsentCount = owned.reduce(0) { $0 + $1.store.comments.filter { $0.state == .local }.count }
    }

    private static func globalized(_ comments: [RenderedComment], _ root: ReviewRoot) -> [RenderedComment] {
        guard !root.prefix.isEmpty else { return comments }
        return comments.map { comment in
            var copy = comment
            copy.fileId = root.global(comment.fileId)
            return copy
        }
    }

    /// Writes every unsent comment with its code into one markdown file, copies it, and, when the
    /// window was opened for a session, tells that session's cmux pane to read it. The pane gets one
    /// line, never the comment text, so nothing multi-line is typed into the agent's prompt.
    func sendToAgent() {
        sendToAgent(ids: commentRoots.flatMap { $0.store.comments.filter { $0.state == .local }.map(\.id) })
    }

    /// The same send for a chosen set of comments (one suggestion sent from its card). `afterSend` runs
    /// when the comments went out; `finished` runs once at the end either way.
    func sendToAgent(ids: [String], afterSend: (() -> Void)? = nil, finished: (() -> Void)? = nil) {
        guard !ids.isEmpty else {
            notice = "No unsent comments."
            finished?()
            return
        }

        // One section per repository: each comment names its file relative to the repository it is in.
        let owners = commentRoots.map { root, store in
            (root: root, store: store, ids: ids.filter { id in store.comments.contains { $0.id == id } })
        }.filter { !$0.ids.isEmpty }
        let message = owners.compactMap { owner -> String? in
            guard let root = owner.root.repo else { return nil }
            let rootBranch = root.path == repo.path ? (remoteHead?.branchNote ?? branch) : owner.root.branch
            return owner.store.agentMessage(repo: root, branch: rootBranch, files: owner.root.files, ids: owner.ids)
        }.joined(separator: "\n")
        let markSent = {
            for owner in owners {
                owner.store.markSent(owner.ids)
            }
        }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let outbox = comments.directory.appendingPathComponent("outbox", isDirectory: true)
        let file = outbox.appendingPathComponent("\(stamp).md")
        do {
            try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
            try message.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            notice = "Could not write \(file.path): \(error.localizedDescription)"
            finished?()
            return
        }

        PathOpener.copy(message, what: "\(ids.count) comments")

        guard let session, session.range(of: "^[A-Za-z0-9-]+$", options: .regularExpression) != nil else {
            markSent()
            afterSend?()
            pushComments()
            notice = "\(ids.count) comments copied. Paste them into the agent, or open the window with --session."
            finished?()
            return
        }

        let line = "Read the review comments in \(file.path) and address each one."
        let host = TerminalHosts.current
        notice = "Sending \(ids.count) comments…"
        Task { @MainActor in
            let error = await Task.detached(priority: .userInitiated) { host.send(sessionId: session, text: line) }.value
            if let error {
                notice = "\(host.name) send failed (\(error.prefix(80))); the comments are copied to the clipboard."
            } else {
                markSent()
                afterSend?()
                pushComments()
                notice = "Sent \(ids.count) comments to session \(session.prefix(8))."
            }
            finished?()
        }
    }

    private func handle(_ event: DiffRendererEvent) {
        switch event {
        case .ready:
            PerfLog.since("hub.review.webview-ready", createdAt)
        case .rendered:
            PerfLog.since("hub.review.render", renderStart)
            renderStart = nil
            if !rendered {
                rendered = true
                onFirstRender?()
            }
            focusPendingThread()
        case .failed(let message):
            error = message
            HubPerf.log("review.renderer failed: \(message)")
            FileHandle.standardError.write(Data("review renderer: \(message)\n".utf8))
        case .commentSubmitted(let input):
            if let id = input.editingID, id.hasPrefix("draft:") {
                updateDraft(id, status: "edited", body: input.body)
            } else if let id = input.editingID, id.hasPrefix("thread:") {
                updateThread(id, editedReply: input.body)
            } else if let id = input.editingID {
                commentOwner(id)?.store.edit(id: id, body: input.body)
                syncEditedDraft(id)
            } else {
                addComment(input)
            }
            pushComments()
        case .commentDeleted(let id):
            deleteLocalComment(id)
        case .openLine(let fileID, let line, let side):
            if let found = locate(fileID: fileID), let root = found.root.repo {
                // A click on the old side carries the old line number; the editor opens the new text.
                let target = side == .deletions
                    ? DiffLineMap.newLine(forOld: line, old: found.file.oldContents, new: found.file.newContents)
                    : line
                if remoteHead != nil, root.path == repo.path {
                    // The file on disk is another branch's copy: the host's copy at the head instead.
                    if let url = hostURL(of: fileID, line: target) {
                        HubPerf.log("review.openLine \(fileID):\(line) \(side.rawValue) -> line \(target) on the host")
                        ExternalOpener.open(url)
                    } else {
                        notice = "No checkout holds this head, and the host has no page for \(found.file.path)."
                    }
                } else {
                    HubPerf.log("review.openLine \(fileID):\(line) \(side.rawValue) -> line \(target) in Cursor")
                    PathOpener.cursor(root.appendingPathComponent(found.file.path).path, line: target)
                }
            } else {
                HubPerf.log("review.openLine unknown file \(fileID)")
            }
        case .commentAction(let id, let action):
            switch action {
            case "accept": updateDraft(id, status: "accepted")
            case "reject": updateDraft(id, status: "rejected")
            case "restore": updateDraft(id, status: "proposed")
            case "agent": send(id, to: .agent)
            case "draft", "promote": send(id, to: .prDraft)
            case "post": send(id, to: .prComment)
            default: HubPerf.log("review.commentAction unknown \(action)")
            }
        case .threadAction(let input):
            threadAction(input)
        case .openURL(let url):
            ExternalOpener.open(url)
        case .focusFile(let id):
            if selectedID != id, files.contains(where: { $0.id == id }) {
                selectedID = id
                sidebarScrollTarget = id
            }
        case .threadSelect(let id, let selected):
            if selected {
                selectedThreads.insert(id)
            } else {
                selectedThreads.remove(id)
            }
        case .key(let key):
            handleKey(key)
        case .blameNeed(let fileID):
            if !blame.loaded.contains(fileID), !blameRunning.contains(fileID) {
                blamePending.insert(fileID)
                runBlame()
            }
        case .blameOpen(let index):
            if let source = blame.source(at: index) {
                AgentBlame.open(source)
            }
        case .headerMenu(let fileID, let selection):
            // After the page's message returns: the menu runs its own tracking loop.
            DispatchQueue.main.async { [weak self] in
                self?.showHeaderMenu(fileID: fileID, selection: selection)
            }
        }
    }

    /// A file's path actions: the file list's context menu and the diff header's right-click menu.
    func pathActions(of file: DiffFile) -> [ReviewPathAction] {
        var actions: [ReviewPathAction] = []
        if let url = hostURL(of: file.id), let head = remoteHead {
            actions.append(ReviewPathAction("Open on the host at \(head.sha.prefix(8))") { ExternalOpener.open(url) })
            actions.append(ReviewPathAction("Copy the host URL") { PathOpener.copy(url.absoluteString, what: "URL") })
        }
        if let path = absolutePath(of: file) {
            actions.append(ReviewPathAction("Open in Cursor") { PathOpener.cursor(path) })
            actions.append(ReviewPathAction("Reveal in Finder") { PathOpener.reveal(path) })
            actions.append(ReviewPathAction("Copy path") { PathOpener.copy(path, what: "path") })
        }
        if let relative = repoPath(of: file.id) {
            actions.append(ReviewPathAction("Copy repo-relative path") { PathOpener.copy(relative, what: "path") })
        }
        return actions
    }

    /// The page sends the file and any text selected there; the menu opens at the pointer.
    private func showHeaderMenu(fileID: String, selection: String) {
        guard let file = files.first(where: { $0.id == fileID }) else {
            HubPerf.log("review.headerMenu unknown file \(fileID)")
            return
        }

        let menu = NSMenu()
        if !selection.isEmpty {
            menu.addItem(ClosureMenuItem("Copy") { PathOpener.copy(selection) })
            menu.addItem(.separator())
        }
        for action in pathActions(of: file) {
            menu.addItem(ClosureMenuItem(action.title, action.run))
        }
        HubPerf.log("review.headerMenu \(file.path) (\(menu.items.count) items)")
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    /// A new local comment, kept in the store of the repository its file is in.
    @discardableResult
    private func addComment(_ input: CommentInput) -> ReviewComment? {
        guard let found = locate(fileID: input.fileID), let store = commentStore(for: found.root) else { return nil }
        var local = input
        local.fileID = found.file.id
        return store.add(local, files: found.root.files)
    }

    // MARK: Agent blame

    /// A snapshot's `--blame <path>:<line>`: asks as a hover would; true once the answer is in.
    func requestBlame(path: String) -> Bool {
        guard let file = file(atPath: path) else { return false }
        if blame.loaded.contains(file.id) {
            return true
        }
        handle(.blameNeed(fileID: file.id))
        return false
    }

    func showBlame(path: String, line: Int) {
        if let file = file(atPath: path) {
            renderer.showBlame(fileID: file.id, line: line)
        }
    }

    /// The file set changed: every file's lines may have moved, so each is asked again on its next hover.
    private func resetBlame() {
        blameGeneration += 1
        blame = AgentBlameState()
        blamePending = []
        blameRunning = []
        renderer.setBlame(blame.payload)
    }

    /// Which session and turn wrote each new line of the hovered files, off the main thread. One call
    /// at a time, for one repository (`--repo`); files hovered meanwhile, or in another root, go in the next one.
    private func runBlame() {
        guard blameRunning.isEmpty, !blamePending.isEmpty else { return }
        guard let index = roots.indices.first(where: { index in blamePending.contains { ReviewRoots.index(of: $0, in: roots) == index } }),
              let root = roots[index].repo else {
            // Files of no root any more (the roots changed): nothing to ask.
            blamePending = []
            return
        }

        let owner = roots[index]
        let asked = blamePending.filter { ReviewRoots.index(of: $0, in: roots) == index }
        blamePending.subtract(asked)
        let chosen = owner.files.filter { asked.contains(owner.global($0.id)) }
        // Repo-relative paths, merged ids: `tools` answers per path, the page asks per id.
        let files = owner.files.map { file -> DiffFile in
            var copy = file
            copy.id = owner.global(file.id)
            return copy
        }
        guard let args = AgentBlame.arguments(repo: root.path, files: chosen, scope: scope) else {
            // Deleted or skipped files have no line to own, and a scope whose new side is not the
            // working tree has no line `tools` could number: asked, with no blame.
            blame.merge(AgentBlameResult(sources: [], files: [], elapsedMs: nil), files: files, asked: asked)
            renderer.setBlame(blame.payload)
            runBlame()
            return
        }

        blameRunning = asked
        let generation = blameGeneration
        DispatchQueue.global(qos: .utility).async {
            let span = HubPerf.begin("review.blame", "\(chosen.count) files in \(root.lastPathComponent)")
            let result = Result { try JSONDecoder().decode(AgentBlameResult.self, from: ToolsCLIRunner.run(args)) }
            switch result {
            case .success(let found): span.end("\(found.files.count) with agent lines, \(found.sources.count) turns, \(found.elapsedMs ?? 0) ms in tools")
            case .failure(let error): span.end("failed: \(error)")
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, generation == self.blameGeneration else { return }
                self.blameRunning = []
                // A failure counts as asked too: the hover must not start a call per line.
                self.blame.merge((try? result.get()) ?? AgentBlameResult(sources: [], files: [], elapsedMs: nil), files: files, asked: asked)
                self.renderer.setBlame(self.blame.payload)
                self.runBlame()
            }
        }
    }

    // MARK: Keys and the Fix selection

    func handleKey(_ key: ReviewKey) {
        HubPerf.log("review.key \(key.rawValue)")
        switch key {
        case .nextThread: stepThread(1)
        case .previousThread: stepThread(-1)
        case .reply:
            guard let card = focusedThreadCard(orStep: true) else { return }
            if card.live?.canReply == true {
                renderer.focusThread(cardID: card.id, reply: true)
            } else {
                notice = "This thread is still your draft: edit it on its card instead of replying."
            }
        case .resolve:
            guard let card = focusedThreadCard(orStep: false), let live = card.live else { return }
            guard live.resolvable else {
                notice = "This thread cannot be resolved (a draft, or the host does not allow it)."
                return
            }
            threadAction(ThreadActionInput(id: card.id, action: live.resolved ? .unresolve : .resolve))
        case .select:
            guard let card = focusedThreadCard(orStep: false) else { return }
            guard card.state != "draft" else {
                notice = "Your own draft is not a thread to fix."
                return
            }
            toggleThreadSelection(ReviewKeyNav.threadID(ofCard: card.id))
        case .fix:
            if pr == nil {
                notice = "This diff is not a PR: there are no threads to fix."
            } else if selectedThreads.isEmpty {
                notice = "Select threads first: their Fix checkbox, or x on the marked thread."
            } else {
                fixRequests += 1
            }
        case .nextFile, .previousFile:
            if let id = ReviewKeyNav.stepFile(files, from: selectedID, by: key == .nextFile ? 1 : -1), id != selectedID {
                select(id)
                sidebarScrollTarget = id
            }
        case .submit:
            if pr?.payload == nil {
                notice = "This diff is not a PR, or its threads have not loaded: there is no review to submit."
            } else {
                submitRequests += 1
            }
        }
    }

    private func stepThread(_ delta: Int) {
        guard let id = ReviewKeyNav.step(threadCards, from: focusedCard, by: delta, files: files, selectedFile: selectedID) else {
            notice = pr == nil
                ? "This diff is not a PR: there are no threads to step through."
                : "No PR thread sits on this diff. Threads show on their lines in the Branch scope or the PR's range."
            return
        }
        focusedCard = id
        renderer.focusThread(cardID: id, reply: false)
    }

    /// The marked card; r with no mark first moves to the next thread, e and x ask for a mark.
    private func focusedThreadCard(orStep: Bool) -> RenderedComment? {
        if focusedCard == nil, orStep {
            stepThread(1)
        }
        guard let focusedCard, let card = threadCards.first(where: { $0.id == focusedCard }) else {
            if !orStep {
                notice = "Move to a thread with j or k first."
            }
            return nil
        }
        return card
    }

    func toggleThreadSelection(_ id: String) {
        if selectedThreads.contains(id) {
            selectedThreads.remove(id)
        } else {
            selectedThreads.insert(id)
        }
    }

    func clearThreadSelection() {
        selectedThreads = []
    }

    /// A button on a live PR thread card. Publishing asks first; deleting a draft asks first. The page
    /// keeps its reply or edit box until `threadActionFinished` says the host took it.
    private func threadAction(_ input: ThreadActionInput) {
        let finished: (Bool) -> Void = { [weak self] ok in
            self?.renderer.threadActionFinished(id: input.id, ok: ok)
        }
        guard let store = pr, let thread = input.threadID else {
            notice = "This diff is not a PR: open the PR in the hub's PRs mode to reply there."
            return finished(false)
        }

        HubPerf.log("review.threadAction \(input.action.rawValue)\(input.draft ? " draft" : "") \(thread)")
        switch input.confirmation {
        case .post?:
            if !PRConfirm.post(input.body?.trimmed ?? "", on: store, where_: "A reply in the existing thread.") {
                return finished(false)
            }
        case .deleteDraft?:
            if !PRConfirm.deleteDraft(on: store) {
                return finished(false)
            }
        case nil:
            break
        }
        store.perform(input, finished: finished)
    }

    private func updateThread(_ id: String, editedReply: String? = nil, replyStatus: String? = nil, providerId: String? = nil) {
        guard let proposal, id.hasPrefix("thread:") else { return }
        do {
            try proposal.update(threadID: String(id.dropFirst(7)), editedReply: editedReply, replyStatus: replyStatus, providerId: providerId)
            objectWillChange.send()
        } catch {
            notice = "Could not save the proposal: \(error.localizedDescription)"
        }
        pushComments()
    }

    // MARK: Sending a suggestion

    enum SendTarget { case agent, prDraft, prComment }

    /// What one card would send: the text as worded now, where it sits, and the PR thread it answers.
    private struct Suggestion {
        let text: String
        let path: String
        let fileID: String
        let side: DiffSide
        let startLine: Int
        let line: Int
        let thread: String?
        /// A local comment that is already my pending draft on the PR: Promote replaces its text, Post
        /// publishes and then deletes it, so the PR never gets the comment twice.
        var pendingDraft: String?
        /// Another root's folder name: the comment is not in the PR's repository, so it cannot go there.
        var otherRoot: String?
        /// The card's kind and state as the page reads them (`SuggestionSendGate`).
        var kind = "local"
        var state: String?
    }

    /// Cards whose send is on its way (a confirmation open, or the agent send running): a second
    /// click on the same card is dropped. A PR write is covered by `PRThreadsStore.busy` once it runs.
    private var sendingSuggestions: Set<String> = []

    private func suggestion(for id: String) -> Suggestion? {
        if let owner = commentOwner(id), let comment = owner.store.comments.first(where: { $0.id == id }),
           let file = owner.root.files.first(where: { $0.path == comment.path }) {
            return Suggestion(text: comment.body, path: comment.path, fileID: owner.root.global(file.id), side: comment.side,
                              startLine: comment.startLine, line: comment.endLine, thread: nil,
                              pendingDraft: comment.state == .draft ? comment.remoteDraftID : nil,
                              otherRoot: owner.root.repo?.path == repo.path ? nil : owner.root.prefix,
                              kind: "local", state: comment.state.rawValue)
        }
        guard let proposal else { return nil }
        let primary = primaryRoot
        if id.hasPrefix("draft:"), let draft = proposal.drafts.first(where: { $0.id == String(id.dropFirst(6)) }),
           let file = primary.files.first(where: { $0.path == draft.path }) {
            return Suggestion(text: draft.editedBody ?? draft.body, path: draft.path, fileID: primary.global(file.id), side: draft.side,
                              startLine: min(draft.startLine, draft.line), line: draft.line,
                              thread: proposal.replyToThread(draftID: draft.id), kind: "draft", state: draft.status)
        }
        if id.hasPrefix("thread:"), let thread = proposal.threads.first(where: { $0.id == String(id.dropFirst(7)) }),
           let text = thread.reply, let file = primary.files.first(where: { $0.path == thread.path }) {
            return Suggestion(text: text, path: thread.path, fileID: primary.global(file.id), side: .additions,
                              startLine: thread.line, line: thread.line, thread: thread.id, kind: "thread", state: thread.replyStatus)
        }
        return nil
    }

    /// One suggestion, as Martin worded it, to the agent (outbox + cmux), as a review draft on the PR, or
    /// published on the PR. Publishing asks first: a posted comment is visible to everyone at once.
    func send(_ id: String, to target: SendTarget) {
        guard let item = suggestion(for: id) else {
            notice = "Nothing to send: the suggestion is empty or its file is not in this diff."
            return
        }
        if let refusal = SuggestionSendGate.refusal(kind: item.kind, state: item.state, toPR: target != .agent,
                                                    inFlight: sendingSuggestions.contains(id), busy: pr?.busy) {
            HubPerf.log("review.send \(id) refused: \(refusal)")
            notice = refusal
            return
        }
        let owner = commentOwner(id)
        let isLocal = owner != nil
        let markSent: (String, String?) -> Void = { [weak self] status, providerId in
            if id.hasPrefix("draft:") {
                self?.updateDraft(id, status: status, providerId: providerId)
            } else if id.hasPrefix("thread:") {
                self?.updateThread(id, replyStatus: status, providerId: providerId)
            } else {
                owner?.store.mark(id, status == "posted" ? .posted : .draft, remoteID: providerId)
                self?.pushComments()
            }
        }

        switch target {
        case .agent:
            if isLocal {
                sendToAgent(ids: [id])
                return
            }
            let where_ = proposal.map { " on \($0.label)" } ?? ""
            let note = item.thread.map { "\(item.text)\n\n(A reply to PR thread \($0.prefix(8))\(where_).)" } ?? item.text
            let input = CommentInput(editingID: nil, fileID: item.fileID, side: item.side, startLine: item.startLine, endLine: item.line, body: note)
            guard let comment = addComment(input) else {
                notice = "Could not anchor the comment on \(item.path):\(item.line)."
                return
            }
            sendingSuggestions.insert(id)
            sendToAgent(ids: [comment.id], afterSend: { markSent("sent", nil) }, finished: { [weak self] in
                self?.sendingSuggestions.remove(id)
            })
        case .prDraft, .prComment:
            guard let store = pr else {
                notice = "This diff is not a PR: open the PR in the hub's PRs mode to post there."
                return
            }
            if let other = item.otherRoot {
                notice = "This comment is on a file in \(other), not in the PR's repository."
                return
            }
            let publish = target == .prComment
            // Held through the confirmation; once the write runs, `store.busy` holds further sends.
            sendingSuggestions.insert(id)
            defer { sendingSuggestions.remove(id) }
            if publish, !confirmPost(item) { return }
            postToProvider(item, store: store, publish: publish) { providerId in
                markSent(publish ? "posted" : "drafted", providerId)
            }
        }
    }

    private func confirmPost(_ item: Suggestion) -> Bool {
        let gitLab = prIdentity?.isGitLab ?? false
        let alert = NSAlert()
        alert.messageText = "Post on \(prLabel) now?"
        alert.informativeText = "Everyone on the \(gitLab ? "merge request" : "pull request") sees it at once. \(item.thread == nil ? "A new thread on \(item.path):\(item.line)." : "A reply in the existing thread.")\n\n\(item.text.prefix(400))"
        alert.addButton(withTitle: "Post")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// `tools hub pr`: a reply in the thread when there is one (`reply`, `--draft` unless published),
    /// else a new draft on the line (`draft add`). A new comment published at once goes alone
    /// (`PRCommand.comment`), since `draft add` + `publish` would send every pending draft.
    /// `done` gets the provider's id for the new comment or draft, when the command returns one.
    private func postToProvider(_ item: Suggestion, store: PRThreadsStore, publish: Bool, done: @escaping (String?) -> Void) {
        let label = prLabel
        let target = store.target
        let args: (String) -> [String]
        let providerId: (Data) -> String?
        if let thread = item.thread {
            args = { PRCommand.reply(target, thread: thread, bodyFile: $0, draft: !publish) }
            providerId = { try? JSONDecoder().decode(PRReplyResult.self, from: $0).commentId }
        } else if let draftId = item.pendingDraft, !publish {
            args = { PRCommand.draftUpdate(target, draftId: draftId, bodyFile: $0) }
            providerId = { _ in draftId }
        } else if let draftId = item.pendingDraft {
            postPendingDraft(item, draftId: draftId, store: store, done: done)
            return
        } else if !publish {
            args = { PRCommand.draftAdd(target, path: item.path, line: item.line, startLine: item.startLine, side: item.side, bodyFile: $0) }
            providerId = { try? JSONDecoder().decode(PRDraftAddResult.self, from: $0).draftId }
        } else {
            args = { PRCommand.comment(target, path: item.path, line: item.line, startLine: item.startLine, side: item.side, bodyFile: $0) }
            providerId = { _ in nil }
        }

        notice = publish ? "Posting on \(label)…" : "Adding to your pending review on \(label)…"
        store.write(publish ? "Posting…" : "Drafting…", body: item.text, args: args) { [weak self] result in
            switch result {
            case .success(let data):
                self?.notice = publish ? "Posted on \(label)." : "In your pending review on \(label); Submit review publishes it."
                done(providerId(data))
            case .failure(let error):
                self?.notice = "\(label) failed: \(error)"
            }
        }
    }

    /// `PRCommand.postPendingDraft`: publish, then delete the pending draft. A failed delete keeps the
    /// comment posted and says the draft is still there; a failed post deletes nothing.
    private func postPendingDraft(_ item: Suggestion, draftId: String, store: PRThreadsStore, done: @escaping (String?) -> Void) {
        let label = prLabel
        let steps = { (bodyFile: String) in
            PRCommand.postPendingDraft(store.target, draftId: draftId, path: item.path, line: item.line,
                                       startLine: item.startLine, side: item.side, bodyFile: bodyFile)
        }
        notice = "Posting on \(label)…"
        HubPerf.log("review.post pending draft \(draftId.prefix(10)) on \(item.path):\(item.line)")
        store.write("Posting…", body: item.text, args: { steps($0)[0] }) { [weak self] result in
            if case .failure(let error) = result {
                self?.notice = "\(label) failed: \(error). Your draft is unchanged."
                return
            }

            done(nil)
            store.write("Removing the draft…", body: nil, args: { _ in steps("")[1] }) { [weak self] removed in
                switch removed {
                case .success: self?.notice = "Posted on \(label); its pending draft is gone."
                case .failure(let error): self?.notice = "Posted on \(label), but the pending draft is still there: \(error)"
                }
            }
        }
    }

    /// Delete on a local card. A comment that is my pending draft on the PR asks whether the draft goes
    /// too; a published comment stays on the PR (only the local card goes).
    private func deleteLocalComment(_ id: String) {
        guard let comments = commentOwner(id)?.store, let comment = comments.comments.first(where: { $0.id == id }) else { return }
        guard comment.state == .draft, let draftId = comment.remoteDraftID, let store = pr else {
            comments.delete(id: id)
            pushComments()
            return
        }

        let alert = NSAlert()
        alert.messageText = "Delete this comment and its draft on \(prLabel)?"
        alert.informativeText = "It is also a draft in your pending review. Nobody else saw the draft.\n\n\(comment.body.prefix(300))"
        alert.addButton(withTitle: "Delete both")
        alert.addButton(withTitle: "Keep the PR draft")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            store.write("Deleting the draft…", body: nil, args: { _ in PRCommand.draftDelete(store.target, draftId: draftId) }) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success:
                    self.comments.delete(id: id)
                    self.notice = "Comment and its PR draft deleted."
                case .failure(let error):
                    self.notice = "Could not delete the PR draft (\(error)); the comment stays."
                }
                self.pushComments()
            }
        case .alertSecondButtonReturn:
            comments.delete(id: id)
            pushComments()
        default:
            break
        }
    }

    /// An edit of a local comment that is my pending draft also replaces the draft's text (it is private
    /// until the review is submitted, so it asks nothing).
    private func syncEditedDraft(_ id: String) {
        guard let comment = comments.comments.first(where: { $0.id == id }), comment.state == .draft,
              let draftId = comment.remoteDraftID, let store = pr else { return }
        store.write("Updating the draft…", body: comment.body, args: { PRCommand.draftUpdate(store.target, draftId: draftId, bodyFile: $0) }) { [weak self] result in
            if case .failure(let error) = result {
                self?.notice = "The comment changed here, but its PR draft kept the old text: \(error)"
            }
        }
    }

    private func updateDraft(_ id: String, status: String, body: String? = nil, providerId: String? = nil) {
        guard let proposal, id.hasPrefix("draft:") else { return }
        do {
            try proposal.update(draftID: String(id.dropFirst(6)), status: status, editedBody: body, providerId: providerId)
            objectWillChange.send()
        } catch {
            notice = "Could not save the proposal: \(error.localizedDescription)"
        }
        pushComments()
    }
}

// MARK: - Views

struct ReviewRootView: View {
    @ObservedObject var model: ReviewModel
    /// False while the hub shows the same list as its own Files pane: one list, not two.
    var showsFileList = true
    @State private var width: CGFloat = 0
    @State private var height: CGFloat = 0

    /// The file list may take 40% of the pane; below its minimum it folds to a rail instead of
    /// squeezing either column. The minimum fits a root folder's name and a typical file name four
    /// folders deep ("qa-decision-delivery.ts"); at 180 pt both were cut to "G…ls/" and "qa-de…very.ts",
    /// at 260 pt the file name still lost six letters.
    private static let listFraction: CGFloat = 0.4
    private static let listMinWidth: CGFloat = 300
    /// The file list opens as wide as its widest row (`FileListFit`), measured once per review; a
    /// saved width from an earlier session opened it at 560 pt for rows that needed about 260.
    @State private var listFit: CGFloat?

    var body: some View {
        let room = width * Self.listFraction
        SideSplit(panelEdge: .trailing, maxFraction: Self.listFraction) {
            diffColumn
                .freezesWidthWhileResizing(heavy: false)
            if showsFileList {
                ResizableSidePanel(key: "review.files", edge: .trailing, title: "Files", defaultWidth: 320,
                                   minWidth: Self.listMinWidth, maxWidth: max(Self.listMinWidth, room),
                                   autoCollapse: width > 0 && room < Self.listMinWidth, fitWidth: listFit) {
                    FileSidebar(model: model)
                }
            }
        }
        .hubSurface(.content)
        .preferredColorScheme(.dark)
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { height = $0 }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        // Once, when the first files arrive: a refresh that adds a longer name never moves the diff.
        .onChange(of: model.files.isEmpty, initial: true) { _, empty in
            guard listFit == nil, !empty else { return }
            listFit = HubPerf.measure("review.files.fit", "\(model.files.count) files") { FileListFit.width(model: model) }
            HubPerf.log("review.files.fit \(Int(listFit ?? 0)) pt for \(model.files.count) files")
        }
        // Back from the browser or another app: the PR threads may have moved (the store skips a load
        // younger than the CLI's 30 s cache).
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.pr?.reloadIfStale()
        }
        // A new model in the same place (the hub selected another session) is a new view: without
        // this, `onAppear` never ran for it and the pane showed "No changes" for a changed repo.
        .id(ObjectIdentifier(model))
    }

    private var diffColumn: some View {
            VStack(spacing: 0) {
                ReviewHeader(model: model)
                if let proposal = model.proposal {
                    ProposalBanner(model: model, proposal: proposal)
                }
                if let pr = model.pr {
                    // Leaves the header, the bar and a few diff lines when the list is dragged tall.
                    PRReviewBar(model: model, store: pr, maxListHeight: height - 240)
                        .zIndex(1)
                }
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.lowercased().contains("could not") || notice.contains("failed")) {
                        model.notice = nil
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
                if let error = model.error {
                    Text(error)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(ReviewPalette.removed)
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if model.files.isEmpty && !model.loading {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 28))
                            .foregroundColor(ReviewPalette.added)
                        Text(verbatim: model.emptyMessage)
                            .foregroundColor(ReviewPalette.dim)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    RendererHost(renderer: model.renderer)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity)
            .clipped()
    }
}

private struct ReviewHeader: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject private var repos = RepoFactsStore.shared

    var body: some View {
        // One row of one height at every width. It used to wrap its controls to a second row in a
        // narrow pane: 44 pt ↔ 61 pt, and a drag across that width moved the whole diff up and
        // down (9 flips in one sweep, measured with --bench). Now only the controls condense.
        HStack(spacing: 10) {
            // The summary gives way too, least useful part first: in a 1100 pt PRs window its fixed
            // labels were wider than the column, and the row overflowed on both sides (audit gap 6).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { summary(.full) }
                HStack(spacing: 8) { summary(.noCompare) }
                HStack(spacing: 8) { summary(.totals) }
                HStack(spacing: 6) { summary(.scope) }
            }
            Spacer(minLength: 8)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { controls(styleWidth: 140) }
                HStack(spacing: 6) { compactControls }
                HStack(spacing: 4) { minimalControls }
            }
            .layoutPriority(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .frame(height: 44)
        .buttonStyle(.genHoverPlain())
        .padding(.leading, model.embedded ? 14 : 78)
        .padding(.trailing, 14)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
        .onGeometryChange(for: Int.self, of: { Int($0.size.height.rounded()) }) { HubBench.note("review.header.height", $0) }
        // A standalone window on a branch with an open PR/MR (`tools hub repo --pr`, the same lookup
        // behind the PR link) gets that PR's threads. The hub attaches its PRs itself.
        .onChange(of: model.embedded ? nil : repos.byPath[model.repo.path]?.pr?.url, initial: true) { _, url in
            if let url, model.pr == nil {
                model.attachPR(.ref(url))
            }
        }
    }

    /// How much of the summary a width holds, from all of it down to the scope menu alone.
    enum SummaryLevel: Int, Comparable {
        case full, noCompare, totals, scope

        static func < (lhs: SummaryLevel, rhs: SummaryLevel) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    @ViewBuilder
    private func summary(_ level: SummaryLevel) -> some View {
        let totals = model.totals
        let facts = repos.facts(for: model.repo.path, pr: true)
            // Inside the hub the worktree / session header above already names the repo and branch.
            if !model.embedded, level <= .noCompare {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundColor(ReviewPalette.dim)
                // Short labels keep their width; only the long branch name gives way (it truncates in
                // the middle), so a crowded header never cuts "PR #424" or the repo to "…".
                ExternalLink(text: model.repo.lastPathComponent, url: facts?.webURL, font: .system(size: 13, weight: .semibold),
                             color: Color.white.opacity(0.92), glyph: .onHover)
                    .fixedSize()
                ExternalLink(text: model.branch, url: facts?.branchURL, glyph: .onHover)
                    .frame(minWidth: 60)
                if level == .full {
                    CompareLink(facts: facts)
                        .fixedSize()
                }
                PullRequestLink(facts: facts)
                    .fixedSize()
            }
            ScopeMenu(model: model)
            if level == .full {
                ScopeLink(model: model, facts: facts)
            }
            if case .lastTurns(let count) = model.scope {
                TurnCountStepper(count: count) { model.setScope(.lastTurns($0)) }
            }
            // Left of the totals, in a slot that is there while idle too: a spinner that came and went
            // among the controls changed the row's width and moved the totals with every load.
            ZStack {
                if model.loading {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(width: 16, height: 16)
            if level <= .totals {
                Text(verbatim: "+\(totals.additions)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(ReviewPalette.added)
                    .fixedSize()
                Text(verbatim: "−\(totals.deletions)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(ReviewPalette.removed)
                    .fixedSize()
            }
            if level <= .noCompare {
                Text(verbatim: "\(model.files.count) files")
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
            }
    }

    @ViewBuilder
    private func controls(styleWidth: CGFloat) -> some View {
            if model.commentCount > 0 {
                Label {
                    Text(verbatim: "\(model.commentCount)")
                } icon: {
                    Image(systemName: "text.bubble")
                }
                .font(.system(size: 12))
                .foregroundColor(ReviewPalette.dim)
                .instantTooltip("\(model.commentCount) comments, \(model.unsentCount) not sent yet")
            }
            Button(action: model.sendToAgent) {
                Label(model.unsentCount > 0 ? "Send \(model.unsentCount)" : "Send", systemImage: "paperplane")
                    .font(.system(size: 12, weight: .semibold))
                    .fixedSize()
            }
            .disabled(model.unsentCount == 0)
            .instantTooltip(model.session == nil
                ? "Copy the comments with their code for an agent"
                : "Send the comments to session \(model.session?.prefix(8) ?? "")")
            Picker("", selection: Binding(get: { model.options.diffStyle }, set: { model.setStyle($0) })) {
                Text("Split").tag(DiffViewOptions.Style.split)
                Text("Unified").tag(DiffViewOptions.Style.unified)
            }
            .pickerStyle(.segmented)
            .frame(width: styleWidth)
            .instantTooltip("Side by side, or one column")
            HStack(spacing: 0) {
                IconButton(systemName: "textformat.size.smaller", tooltip: "Smaller diff text") { model.stepFont(-1) }
                Text(verbatim: "\(Int(model.options.fontSize))")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 18)
                IconButton(systemName: "textformat.size.larger", tooltip: "Larger diff text") { model.stepFont(1) }
            }
            IconButton(
                systemName: model.options.wrap ? "text.alignleft" : "arrow.left.and.right.text.vertical",
                tooltip: model.options.wrap ? "Long lines wrap (click to scroll instead)" : "Long lines scroll (click to wrap)"
            ) { model.toggleWrap() }
            findButton
            IconButton(systemName: "arrow.clockwise", tooltip: "Reload the diff") { model.reload() }
    }

    private var findButton: some View {
        IconButton(systemName: "magnifyingglass", tooltip: "Find in every file of the diff (⌘F)") { model.find() }
    }

    private var sendButton: some View {
        IconButton(systemName: "paperplane",
                   tooltip: model.unsentCount > 0 ? "Send \(model.unsentCount) comments to the agent" : "No unsent comments") {
            model.sendToAgent()
        }
        .disabled(model.unsentCount == 0)
    }

    /// Icons instead of labels, and the text size behind a menu.
    @ViewBuilder
    private var compactControls: some View {
        sendButton
        IconButton(systemName: model.options.diffStyle == .split ? "rectangle.split.2x1" : "rectangle",
                   tooltip: model.options.diffStyle == .split ? "Side by side (click for one column)" : "One column (click for side by side)") {
            model.setStyle(model.options.diffStyle == .split ? .unified : .split)
        }
        IconButton(
            systemName: model.options.wrap ? "text.alignleft" : "arrow.left.and.right.text.vertical",
            tooltip: model.options.wrap ? "Long lines wrap (click to scroll instead)" : "Long lines scroll (click to wrap)"
        ) { model.toggleWrap() }
        findButton
        viewMenu
        IconButton(systemName: "arrow.clockwise", tooltip: "Reload the diff") { model.reload() }
    }

    /// The narrowest pane: send, and everything else in one menu.
    @ViewBuilder
    private var minimalControls: some View {
        sendButton
        viewMenu
    }

    private var viewMenu: some View {
        Menu {
            Picker("Layout", selection: Binding(get: { model.options.diffStyle }, set: { model.setStyle($0) })) {
                Text("Side by side").tag(DiffViewOptions.Style.split)
                Text("One column").tag(DiffViewOptions.Style.unified)
            }
            Toggle("Wrap long lines", isOn: Binding(get: { model.options.wrap }, set: { _ in model.toggleWrap() }))
            Divider()
            Button("Larger text") { model.stepFont(1) }
            Button("Smaller text") { model.stepFont(-1) }
            Divider()
            Button("Find in the Diff…") { model.find() }
            Button("Reload") { model.reload() }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .instantTooltip("Layout, wrap, text size, find, reload")
    }
}

/// "−  3  +" beside the scope menu while it shows the last N turns: widens or narrows N.
private struct TurnCountStepper: View {
    let count: Int
    let change: (Int) -> Void

    var body: some View {
        HStack(spacing: 2) {
            IconButton(systemName: "minus", tooltip: "One turn fewer", size: 10) { change(max(1, count - 1)) }
                .disabled(count <= 1)
            Text(verbatim: "\(count)")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .frame(minWidth: 18)
            IconButton(systemName: "plus", tooltip: "One turn more", size: 10) { change(min(99, count + 1)) }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "Last \(count) turns"))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: change(min(99, count + 1))
            case .decrement: change(max(1, count - 1))
            @unknown default: break
            }
        }
    }
}

/// The scope's own page on the host, beside the scope menu: the commit, or the compare view of the
/// range or of the branch against its base. Nothing when the origin is not GitHub or GitLab, and
/// nothing for working-tree scopes, which have no page.
private struct ScopeLink: View {
    @ObservedObject var model: ReviewModel
    let facts: RepoFacts?

    var body: some View {
        if let forge = facts?.forge, let item = link(forge) {
            ExternalLink(text: item.text, url: item.url, font: .system(size: 11.5, design: .monospaced), glyph: .onHover, tooltip: item.tooltip)
                .fixedSize()
        }
    }

    private func link(_ forge: ForgeWeb) -> (text: String, url: URL, tooltip: String)? {
        switch model.scope {
        case .commit(let sha, let title):
            return forge.commit(sha).map { (String(sha.prefix(8)), $0, "Commit \(sha.prefix(8)): \(title)") }
        case .range(let base, let head, _, _):
            return forge.compare(base: base, head: head).map { ("compare", $0, "Compare \(base.prefix(8))...\(head.prefix(8))") }
        case .branch:
            // A branch with a PR/MR already has CompareLink in the standalone header.
            if !model.embedded, facts?.pr != nil { return nil }
            guard let base = model.base, base != "HEAD", !model.branch.isEmpty else { return nil }
            let target = base.hasPrefix("origin/") ? String(base.dropFirst(7)) : base
            return forge.compare(base: target, head: model.branch).map { ("compare", $0, "Compare \(target)...\(model.branch)") }
        default:
            return nil
        }
    }
}

/// Codex's review source menu: what the diff compares.
private struct ScopeMenu: View {
    @ObservedObject var model: ReviewModel

    var body: some View {
        // Its own width when that fits, so the totals sit beside it (the flexible frame alone grew to
        // 380 pt for "Uncommitted" and left a wide gap before them). It shrinks in a narrow pane instead
        // of pushing the header past both edges: a PR range label
        // ("feature/next…chore/col-302921-repo-cleanup") is wider than the whole diff pane at 1000 pt.
        ViewThatFits(in: .horizontal) {
            menu.fixedSize()
            menu.frame(minWidth: 80, maxWidth: 380, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
        .instantTooltip("What this diff compares: \(label)")
    }

    private var menu: some View {
        Menu {
            // Always offered with a session: a turn without changes is an empty panel that the next
            // turn fills, not a greyed-out item.
            scopeButton(.lastTurns(1))
                .disabled(model.session == nil || model.remoteHead != nil)
            Button("Last Turns…") { model.setScope(.lastTurns(3)) }
                .disabled(model.session == nil || model.remoteHead != nil)
            Divider()
            scopeButton(.uncommitted)
            scopeButton(.unstaged)
            scopeButton(.staged)
            Divider()
            Menu("Committed") {
                if model.commits.isEmpty {
                    Text("No commits ahead of the base")
                }
                ForEach(model.commits) { commit in
                    Button("\(commit.short)  \(commit.subject)  ·  \(commit.when)") {
                        model.setScope(.commit(sha: commit.sha, title: commit.subject))
                    }
                }
            }
            scopeButton(.branch)
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .menuStyle(.borderlessButton)
    }

    private var label: String {
        switch model.scope {
        case .branch: return "Branch vs \(model.base ?? "base")"
        case .commit(let sha, let title): return "\(sha.prefix(7)) \(title.prefix(40))"
        default: return model.scope.title
        }
    }

    private func scopeButton(_ scope: DiffScope) -> some View {
        Button {
            model.setScope(scope)
        } label: {
            if model.scope == scope {
                Label(scope.title, systemImage: "checkmark")
            } else {
                Text(scope.title)
            }
        }
        // No checkout holds the head: the working tree on disk belongs to another branch.
        .disabled(model.remoteHead != nil && scope.readsTheCheckout)
    }
}

/// The agent's overall verdict above the diff, with a tally of what Martin decided so far.
/// Chip, then three lines: who reviewed what (one line), the counts (one line, or two short ones in a
/// narrow pane), the summary. The counts used to share the title's row and broke "!7455" in two.
private struct ProposalBanner: View {
    @ObservedObject var model: ReviewModel
    let proposal: ProposalDocument

    private struct Count {
        let text: String
        var color = ReviewPalette.dim
        /// Left out of the short form when it is zero.
        var optional = false
        var value = 1
    }

    var body: some View {
        let color: Color = proposal.decision == "approve" ? ReviewPalette.added : proposal.decision == "request_changes" ? ReviewPalette.removed : ReviewPalette.modified
        let (drafts, extra) = counts
        let short = drafts.filter { !$0.optional || $0.value > 0 }
        HStack(alignment: .top, spacing: 12) {
            Text(proposal.decision.replacingOccurrences(of: "_", with: " ").uppercased())
                .font(.system(size: 10.5, weight: .bold))
                .foregroundColor(.black.opacity(0.85))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(color))
                .fixedSize()
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(verbatim: "\(proposal.agent) reviewed \(proposal.label)")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let confidence = proposal.confidence {
                        Text(verbatim: "[\(confidence)%]")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                            .fixedSize()
                    }
                }
                ViewThatFits(in: .horizontal) {
                    line(drafts + extra)
                    line(short + extra)
                    VStack(alignment: .leading, spacing: 2) {
                        line(short)
                        if !extra.isEmpty {
                            line(extra)
                        }
                    }
                }
                .font(.system(size: 11.5))
                .instantTooltip(proposal.threads.isEmpty
                    ? "The agent's drafts and what you did with them"
                    : "The agent's drafts, and the threads already on the PR (the agent's read sits under each one it checked)")
                Text(proposal.summary)
                    .font(.system(size: 12.5))
                    .foregroundColor(Color.white.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.35)))
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }

    /// The draft tally, and what else there is to know (drafts off this diff, the PR's threads).
    private var counts: ([Count], [Count]) {
        let drafts = proposal.drafts
        let tally = Dictionary(grouping: drafts, by: \.status).mapValues(\.count)
        let decided = { (status: String) -> Count in
            let value = tally[status] ?? 0
            return Count(text: "\(value) \(status)", optional: true, value: value)
        }
        let draftCounts = [
            Count(text: "\(drafts.count) drafts"),
            Count(text: "\(tally["proposed"] ?? 0) open"),
            decided("accepted"),
            decided("edited"),
            decided("rejected"),
        ]
        var extra: [Count] = []
        let unplaced = proposal.unplaced(in: model.files)
        if unplaced > 0 {
            extra.append(Count(text: "\(unplaced) not in this diff", color: ReviewPalette.modified))
        }
        let threads = proposal.threads
        if !threads.isEmpty {
            let open = threads.filter { !$0.resolved }.count
            extra.append(Count(text: "\(threads.count) PR threads, \(open) open", color: open > 0 ? ReviewPalette.modified : ReviewPalette.dim))
        }
        return (draftCounts, extra)
    }

    /// One line of counts with dim " · " between them; never wraps (ViewThatFits picks a shorter form).
    private func line(_ parts: [Count]) -> some View {
        parts.enumerated().reduce(Text(verbatim: "")) { text, item in
            let separator = Text(verbatim: item.offset == 0 ? "" : " · ").foregroundColor(ReviewPalette.dim)
            return text + separator + Text(verbatim: item.element.text).foregroundColor(item.element.color)
        }
        .lineLimit(1)
        .fixedSize()
    }
}

struct SidebarRow: Identifiable {
    enum Kind {
        /// A root's folder in a review of several repositories: its checkbox, remove and error live here.
        case root(index: Int, additions: Int, deletions: Int)
        case directory(name: String, additions: Int, deletions: Int)
        case file(DiffFile)
    }

    let id: String
    let depth: Int
    let kind: Kind
}

private final class TreeNode {
    let name: String
    let path: String
    var children: [String: TreeNode] = [:]
    var files: [DiffFile] = []

    init(name: String, path: String) {
        self.name = name
        self.path = path
    }

    var totals: (Int, Int) {
        let own = files.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
        return children.values.reduce(own) { sum, child in
            let t = child.totals
            return (sum.0 + t.0, sum.1 + t.1)
        }
    }
}

/// Flat: one header per directory, like GitHub's file list. Tree: nested folders, where a chain of
/// single-child folders collapses into one row (`src/browser-router/lib`), like Codex's review pane.
/// With several roots, each root is one top-level row in root order (never folded into its first
/// folder), with its files under it; a root with no files keeps its row.
func sidebarRows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>, roots: [ReviewRoot] = []) -> [SidebarRow] {
    guard roots.count > 1 else {
        return sidebarRows(files, tree: tree, collapsed: collapsed, depth: 0, strip: "")
    }

    return roots.enumerated().flatMap { index, root -> [SidebarRow] in
        let own = files.filter { ReviewRoots.index(of: $0.id, in: roots) == index }
        let totals = own.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
        let row = SidebarRow(id: root.rowID, depth: 0, kind: .root(index: index, additions: totals.0, deletions: totals.1))
        guard !collapsed.contains(root.rowID) else { return [row] }
        return [row] + sidebarRows(own, tree: tree, collapsed: collapsed, depth: 1, strip: root.prefix + "/")
    }
}

/// One root's rows. `strip` is the root's prefix: folder names read without it, ids keep it.
private func sidebarRows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>, depth: Int, strip: String) -> [SidebarRow] {
    guard tree else {
        let grouped = Dictionary(grouping: files, by: \.directory)
        return grouped.keys.sorted().flatMap { directory -> [SidebarRow] in
            let group = grouped[directory] ?? []
            let name = directory.hasPrefix(strip) ? String(directory.dropFirst(strip.count)) : ""
            let header = name.isEmpty
                ? []
                : [SidebarRow(id: "dir:\(directory)", depth: depth, kind: .directory(name: name, additions: 0, deletions: 0))]
            return header + group.map { SidebarRow(id: $0.id, depth: depth, kind: .file($0)) }
        }
    }

    let top = TreeNode(name: "", path: "")
    for file in files {
        var node = top
        for part in file.directory.split(separator: "/").map(String.init) where !file.directory.isEmpty {
            let path = node.path.isEmpty ? part : "\(node.path)/\(part)"
            if node.children[part] == nil {
                node.children[part] = TreeNode(name: part, path: path)
            }
            node = node.children[part]!
        }
        node.files.append(file)
    }

    var rows: [SidebarRow] = []
    func walk(_ node: TreeNode, depth: Int) {
        for child in node.children.values.sorted(by: { $0.name < $1.name }) {
            var folder = child
            var label = child.name
            while folder.files.isEmpty, folder.children.count == 1, let only = folder.children.values.first {
                folder = only
                label += "/\(only.name)"
            }
            let totals = folder.totals
            let id = "dir:\(folder.path)"
            rows.append(SidebarRow(id: id, depth: depth, kind: .directory(name: label, additions: totals.0, deletions: totals.1)))
            if !collapsed.contains(id) {
                walk(folder, depth: depth + 1)
            }
        }
        for file in node.files.sorted(by: { $0.name < $1.name }) {
            rows.append(SidebarRow(id: file.id, depth: depth, kind: .file(file)))
        }
    }
    // Several roots: the walk starts inside the root's own folder, which the caller drew already.
    let start = strip.isEmpty ? top : top.children[String(strip.dropLast())]
    if let start {
        walk(start, depth: depth)
    }
    return rows
}

/// Not private: reused standalone as the hub's "Files" pane (`HubTab.files` in HubWindow.swift).
struct FileSidebar: View {
    @ObservedObject var model: ReviewModel
    @FocusState private var filterFocused: Bool

    var body: some View {
        let rows = sidebarRows(model.filteredFiles, tree: model.treeMode && model.filter.isEmpty, collapsed: model.collapsed, roots: model.roots)
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(ReviewPalette.dim)
                    TextField("Filter files…", text: $model.filter)
                        .textFieldStyle(.plain)
                        .focused($filterFocused)
                }
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
                Button {
                    model.treeMode.toggle()
                } label: {
                    Image(systemName: model.treeMode ? "list.bullet.indent" : "list.bullet")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(model.treeMode ? "Tree view (click for flat list)" : "Flat list (click for tree view)")
            }
            .padding(.horizontal, 10)
            // Standalone, the list starts under the transparent title bar; in the hub its pane has a
            // title above it already, and 52 pt left an empty band beside the diff's header.
            .padding(.top, model.embedded ? 8 : 52)
            .padding(.bottom, 8)

            if rows.isEmpty, !model.loading {
                Text(model.filter.isEmpty ? "No changed files" : "No file matches “\(model.filter)”")
                    .font(.system(size: 12))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(rows) { row in
                            switch row.kind {
                            case .root(let index, let additions, let deletions):
                                let root = model.roots[index]
                                RootFolderRow(root: root, additions: additions, deletions: deletions,
                                              collapsed: model.collapsed.contains(row.id), actions: model.rootActions) {
                                    if model.collapsed.contains(row.id) {
                                        model.collapsed.remove(row.id)
                                    } else {
                                        model.collapsed.insert(row.id)
                                    }
                                }
                                .padding(.horizontal, 6)
                                .padding(.top, index == 0 ? 0 : 6)
                            case .directory(let name, let additions, let deletions):
                                let tree = model.treeMode && model.filter.isEmpty
                                DirectoryRow(
                                    name: name,
                                    depth: row.depth,
                                    additions: additions,
                                    deletions: deletions,
                                    tree: tree,
                                    collapsed: model.collapsed.contains(row.id)
                                )
                                .rowButton(cornerRadius: 6) {
                                    if model.collapsed.contains(row.id) {
                                        model.collapsed.remove(row.id)
                                    } else {
                                        model.collapsed.insert(row.id)
                                    }
                                }
                                // The gap above a flat-list group sits outside the button, so the
                                // hover box covers the folder name and nothing above it.
                                .padding(.horizontal, 6)
                                .padding(.top, tree ? 0 : 8)
                            case .file(let file):
                                FileRow(file: file, selected: file.id == model.selectedID, depth: row.depth)
                                    .id(file.id)
                                    .rowButton(cornerRadius: 6) { model.select(file.id) }
                                    .contextMenu { fileMenu(file) }
                                    .padding(.horizontal, 6)
                            }
                        }
                    }
                    .padding(.bottom, 12)
                }
                .onChange(of: model.sidebarScrollTarget) { id in
                    guard let id else { return }
                    // Unfold the folders above the target so the row exists, then scroll only as far as needed.
                    for folder in model.collapsed where id.hasPrefix(String(folder.dropFirst(4)) + "/") {
                        model.collapsed.remove(folder)
                    }
                    DispatchQueue.main.async {
                        proxy.scrollTo(id)
                    }
                }
            }
        }
        .hubSurface(.chrome)
        // ⌘F with the keyboard in the file list focuses its filter (Hub/HubPanelFind.swift).
        .panelFindNative("files") { filterFocused = true }
    }

    /// Open, copy or reveal the file in its own repository (with several roots, not `model.repo`).
    /// The same list as the diff header's right-click menu (`ReviewModel.pathActions`).
    @ViewBuilder
    private func fileMenu(_ file: DiffFile) -> some View {
        ForEach(model.pathActions(of: file)) { action in
            Button(action.title, action: action.run)
        }
    }
}

/// The file list's width that shows every visible row whole: the widest of its rows as they draw
/// (`FileRow`, `DirectoryRow`, `RootFolderRow`: indent, chevron or status dot, name, the +N −M
/// counts, their paddings and HStack spacings), plus a legacy scroller when the system shows one.
enum FileListFit {
    private static let fileName = NSFont.systemFont(ofSize: 12.5)
    private static let folderName = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    private static let rootName = NSFont.systemFont(ofSize: 12, weight: .semibold)
    private static let counts = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    /// The row's hover box sits 6 pt inside the list on each side.
    private static let rowInset: CGFloat = 12
    /// Rounding and the text's own side bearings.
    private static let slack: CGFloat = 6

    @MainActor
    static func width(model: ReviewModel) -> CGFloat {
        let tree = model.treeMode && model.filter.isEmpty
        let rows = sidebarRows(model.filteredFiles, tree: tree, collapsed: model.collapsed, roots: model.roots)
        let widest = rows.map { rowWidth($0, tree: tree, roots: model.roots, hasRootActions: model.rootActions != nil) }.max() ?? 0
        let scroller = NSScroller.preferredScrollerStyle == .legacy ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
        return (widest + rowInset + slack + scroller).rounded(.up)
    }

    private static func text(_ string: String, _ font: NSFont) -> CGFloat {
        ceil((string as NSString).size(withAttributes: [.font: font]).width)
    }

    /// "+N" and "−M" with `spacing` before each one that shows.
    private static func totals(_ additions: Int, _ deletions: Int, spacing: CGFloat) -> CGFloat {
        (additions > 0 ? spacing + text("+\(additions)", counts) : 0) + (deletions > 0 ? spacing + text("−\(deletions)", counts) : 0)
    }

    private static func rowWidth(_ row: SidebarRow, tree: Bool, roots: [ReviewRoot], hasRootActions: Bool) -> CGFloat {
        let indent = 6 + CGFloat(row.depth) * 14
        switch row.kind {
        case .file(let file):
            // dot 6, name, a 4 pt spacer, the counts; 8 pt apart; 6 pt trailing.
            let skipped: CGFloat = file.skipped == nil ? 0 : 8 + 16
            return indent + 6 + 8 + text(file.name, fileName) + 8 + 4 + skipped + totals(file.additions, file.deletions, spacing: 8) + 6
        case .directory(let name, let additions, let deletions):
            // Counts show only on a folded folder of the tree.
            let chevron: CGFloat = tree ? 10 + 6 : 0
            return indent + chevron + text(name, folderName) + 6 + 4 + totals(additions, deletions, spacing: 6) + 6
        case .root(let index, let additions, let deletions):
            let root = roots.indices.contains(index) ? roots[index] : nil
            // chevron 10, folder icon 12, the name; the checkbox and the remove button beside the row.
            let actions: CGFloat = hasRootActions ? 6 + 18 + ((root?.removable ?? false) ? 6 + 22 : 0) : 0
            return 6 + 10 + 6 + 12 + 6 + text("\(root?.prefix ?? "")/", rootName) + 6 + 4 + totals(additions, deletions, spacing: 6) + 6 + actions
        }
    }
}

/// One entry of a file's path menu (`ReviewModel.pathActions`).
struct ReviewPathAction: Identifiable {
    let title: String
    let run: () -> Void

    var id: String { title }

    init(_ title: String, _ run: @escaping () -> Void) {
        self.title = title
        self.run = run
    }
}

/// A root's folder in a review of several repositories: the name, its totals, "In Changes" and remove.
/// The menu holds the same, plus the usual path actions; a failed load shows here, not over the pane.
private struct RootFolderRow: View {
    let root: ReviewRoot
    let additions: Int
    let deletions: Int
    let collapsed: Bool
    let actions: ReviewRootActions?
    let toggle: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(collapsed || !root.shown ? 0 : 90))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 10)
                Image(systemName: "folder.fill")
                    .font(.system(size: 10.5))
                    .foregroundColor(root.shown ? ReviewPalette.renamed : ReviewPalette.dim)
                // The folder's name stays whole ("G…ls/" named nothing); the totals give way first.
                Text(verbatim: "\(root.prefix)/")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(root.shown ? .primary : ReviewPalette.dim)
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(2)
                if let error = root.error {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundColor(ReviewPalette.removed)
                    Text(error)
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.removed)
                        .lineLimit(1)
                        .truncationMode(.tail)
                } else if !root.shown {
                    Text("not in Changes").font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                }
                Spacer(minLength: 4)
                // Whole numbers or none: a cut total ("+123…") read as a different number.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        if additions > 0 {
                            Text(verbatim: "+\(additions)").foregroundColor(ReviewPalette.added)
                        }
                        if deletions > 0 {
                            Text(verbatim: "−\(deletions)").foregroundColor(ReviewPalette.removed)
                        }
                    }
                    .fixedSize()
                    if additions > 0 {
                        Text(verbatim: "+\(additions)").foregroundColor(ReviewPalette.added).fixedSize()
                    }
                    Color.clear.frame(width: 0, height: 0)
                }
                .layoutPriority(1)
            }
            .font(.system(size: 11, design: .monospaced))
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .frame(height: 26)
            .contentShape(Rectangle())
            .rowButton(cornerRadius: 6, toggle)
            .instantTooltip(root.error.map { "\(root.folder)\n\($0)" } ?? root.folder)
            if let actions {
                Toggle("", isOn: Binding(get: { root.shown }, set: { actions.setShown(root.folder, $0) }))
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                    .disabled(root.repo == nil)
                    .instantTooltip(root.shown ? "In Changes: untick to hide this folder's changes" : "Tick to show this folder's changes")
                if root.removable {
                    IconButton(systemName: "xmark", tooltip: "Remove this folder from the session", size: 9) {
                        actions.remove(root.folder)
                    }
                }
            }
        }
        .contextMenu {
            if let actions {
                Button(root.shown ? "Hide from Changes" : "Show in Changes") { actions.setShown(root.folder, !root.shown) }
                    .disabled(root.repo == nil)
                if root.removable {
                    Button("Remove folder from session") { actions.remove(root.folder) }
                }
                Divider()
            }
            Button("Open in Cursor") { PathOpener.cursor(root.folder) }
            Button("Open in Finder") { PathOpener.finder(root.folder) }
            Button("Open in cmux") { PathOpener.cmux(root.folder) }
            Button("Copy path") { PathOpener.copy(root.folder, what: "path") }
        }
    }
}

private struct DirectoryRow: View {
    let name: String
    let depth: Int
    let additions: Int
    let deletions: Int
    let tree: Bool
    let collapsed: Bool

    var body: some View {
        HStack(spacing: 6) {
            if tree {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 10)
            }
            Text(name)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
                .truncationMode(.head)
                .instantTooltip(name)
            Spacer(minLength: 4)
            if tree && collapsed {
                if additions > 0 {
                    Text(verbatim: "+\(additions)").foregroundColor(ReviewPalette.added.opacity(0.7))
                }
                if deletions > 0 {
                    Text(verbatim: "−\(deletions)").foregroundColor(ReviewPalette.removed.opacity(0.7))
                }
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.leading, 6 + CGFloat(depth) * 14)
        .padding(.trailing, 6)
        .frame(height: 24)
        .contentShape(Rectangle())
    }
}

private struct FileRow: View {
    let file: DiffFile
    let selected: Bool
    var depth = 0

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(ReviewPalette.color(file.status))
                .frame(width: 6, height: 6)
            Text(file.name)
                .font(.system(size: 12.5))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if file.skipped != nil {
                Image(systemName: "doc.badge.ellipsis")
                    .foregroundColor(ReviewPalette.dim)
            }
            if file.additions > 0 {
                Text(verbatim: "+\(file.additions)")
                    .foregroundColor(ReviewPalette.added)
            }
            if file.deletions > 0 {
                Text(verbatim: "−\(file.deletions)")
                    .foregroundColor(ReviewPalette.removed)
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.leading, 6 + CGFloat(depth) * 14)
        .padding(.trailing, 6)
        .frame(height: 26)
        // Same shape as the row hover (HubRowButtonStyle, radius 6, same inset): one box, not two.
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(selected ? ReviewPalette.renamed.opacity(0.16) : Color.clear)
                .overlay(alignment: .leading) {
                    if selected {
                        Capsule().fill(ReviewPalette.renamed).frame(width: 3, height: 14).padding(.leading, 1)
                    }
                }
        )
        .contentShape(Rectangle())
        .instantTooltip(file.path)
    }
}

/// SwiftUI gets a fresh container per `makeNSView`; the renderer's one long-lived view moves into
/// whichever container is current. Handing SwiftUI the same NSView from two makeNSView calls (the
/// hub re-creates this view on tab and header changes) crashed layout in StackLayout.sizeThatFits.
private struct RendererHost: NSViewRepresentable {
    let renderer: DiffRenderer

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        if renderer.view.superview !== container {
            attach(to: container)
        }
    }

    private func attach(to container: NSView) {
        let view = renderer.view
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}

// MARK: - Live reload

/// FSEvents on the repository with the stream's own latency as the debounce; `.git/` noise is
/// ignored except the index and HEAD, which move on commit, checkout and stage.
/// The stream holds this box (retained, released by the stream), never the watcher itself, so an
/// event queued after the watcher is gone finds a nil reference instead of freed memory.
private final class RepoWatcherBox {
    weak var watcher: RepoWatcher?

    init(_ watcher: RepoWatcher) {
        self.watcher = watcher
    }
}

private final class RepoWatcher {
    private var stream: FSEventStreamRef?
    private let onChange: () -> Void
    private let root: String

    init(root: URL, onChange: @escaping () -> Void) {
        self.root = root.path
        self.onChange = onChange
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passRetained(RepoWatcherBox(self)).toOpaque(),
            retain: nil,
            release: { info in
                if let info {
                    Unmanaged<RepoWatcherBox>.fromOpaque(info).release()
                }
            },
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info, let watcher = Unmanaged<RepoWatcherBox>.fromOpaque(info).takeUnretainedValue().watcher else { return }
            let list = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
            if list.prefix(count).contains(where: watcher.matters) {
                watcher.onChange()
            }
        }
        stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            [root.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.35,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents)
        )
        if let stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
        }
    }

    deinit {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    private func matters(_ path: String) -> Bool {
        if path.contains("/node_modules/") || path.contains("/.build/") {
            return false
        }

        if path.contains("/.git/") {
            return path.hasSuffix("/.git/index") || path.hasSuffix("/.git/HEAD")
        }

        return true
    }
}

// MARK: - Snapshot

/// Writes the window as a PNG without Screen Recording: the SwiftUI chrome through
/// `cacheDisplay`, the web content through WKWebView's own snapshot, composited at its frame.
enum ReviewSnapshot {
    static func write(window: NSWindow, webView: WKWebView?, to path: String, done: @escaping () -> Void) {
        guard let content = window.contentView else {
            done()
            return
        }

        let bounds = content.bounds
        guard let rep = content.bitmapImageRepForCachingDisplay(in: bounds) else {
            done()
            return
        }

        content.cacheDisplay(in: bounds, to: rep)
        let image = NSImage(size: bounds.size)
        image.addRepresentation(rep)

        guard let webView else {
            save(image, to: path)
            done()
            return
        }

        webView.takeSnapshot(with: nil) { webImage, _ in
            if let webImage {
                var frame = webView.convert(webView.bounds, to: content)
                if content.isFlipped {
                    frame.origin.y = bounds.height - frame.maxY
                }
                let composed = NSImage(size: bounds.size)
                composed.lockFocus()
                image.draw(in: bounds)
                webImage.draw(in: frame)
                composed.unlockFocus()
                save(composed, to: path)
            } else {
                save(image, to: path)
            }
            done()
        }
    }

    private static func save(_ image: NSImage, to path: String) {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else { return }
        try? png.write(to: URL(fileURLWithPath: path))
    }
}
