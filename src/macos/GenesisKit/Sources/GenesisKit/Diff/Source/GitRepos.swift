//
//  GitRepos.swift
//  GenesisKit
//
//  The repositories the git components show, one status per repository: one `git status` serves every tab, the
//  status bar and the file tree. A repository refreshes a quarter second after its git folder changes (the index
//  and HEAD: a stage, a commit, a checkout) or a host says one of its files was saved, and at most every
//  `workingTreeInterval` while files change in its working tree (another program's edit, an agent's new file).
//  Idle, it costs nothing: file events, no timer.
//
//  The views of a repository (each window's status bar, gutter, file tree and histories) share its reads: a read
//  wakes the views that follow its status only when the status or HEAD changed, and what they derive from it (a
//  file's state, the tree's line counts) runs once per read for all of them. Before that, every git-folder event
//  (another session's `git status` refreshing the index) woke each view, and each found its repository again and read
//  its own status: 42 git runs for five windows and one burst, about 40 every 10 s in Genesis Markdown (2026-11-12).
//

import Combine
import Foundation

@MainActor
public final class GitRepos: ObservableObject {
    public static let shared = GitRepos()

    /// Bumped when a folder's repository becomes known, so a view that asked before redraws.
    @Published public private(set) var revision = 0
    private var models: [String: GitRepoModel] = [:]
    /// Folder path → its repository's root path; "" for a folder outside any repository.
    private var roots: [String: String] = [:]
    private var looking = Set<String>()

    /// What is known about the repository holding a folder. A view shows "not in a git repository" only for
    /// `.none`: while the lookup runs the answer is not known, and showing the negative one flashed it on every
    /// open (Martin, 2026-10-13).
    public enum Lookup {
        case pending
        case none
        case repo(GitRepoModel)

        public var model: GitRepoModel? {
            if case .repo(let model) = self { return model }
            return nil
        }
    }

    /// The repository holding `folder`. nil while it is looked up (the answer bumps `revision`) and for a folder
    /// outside any repository; `lookup(for:)` tells the two apart.
    public func model(for folder: URL) -> GitRepoModel? {
        lookup(for: folder).model
    }

    /// The repository holding `folder`, a folder outside any repository, or a lookup still running (it starts one).
    public func lookup(for folder: URL) -> Lookup {
        let key = folder.standardizedFileURL.path
        if let root = roots[key] {
            guard !root.isEmpty, let model = models[root] else { return .none }
            return .repo(model)
        }
        guard looking.insert(key).inserted else { return .pending }
        let provider = GenesisKitGT.provider
        DispatchQueue.global(qos: .utility).async {
            let root = GitQueries(provider: provider).root(of: folder)
            DispatchQueue.main.async {
                self.looking.remove(key)
                guard let root else {
                    self.roots[key] = ""
                    self.revision += 1
                    return
                }
                let rootKey = root.path
                if self.models[rootKey] == nil {
                    self.models[rootKey] = GitRepoModel(root: root)
                }
                self.roots[key] = rootKey
                self.revision += 1
            }
        }
        return .pending
    }

    /// The repository of a file that was just saved, refreshed now rather than on its next git event.
    public func noteSaved(_ file: URL) {
        model(for: file.deletingLastPathComponent())?.refresh()
    }
}

/// One repository's status, kept current.
@MainActor
public final class GitRepoModel: ObservableObject {
    public let root: URL
    @Published public private(set) var status: GitRepoStatus?
    /// The last status read failed: `status` keeps the last good answer, and the panel says the refresh failed.
    @Published public private(set) var failure: GitFailure?
    /// Bumped by a refresh that changed the status, or that git's own folder, a save or a retry asked for (HEAD or the
    /// index can change while the status stays equal): followers reload on it.
    @Published public private(set) var generation = 0
    /// Bumped by every completed read, also one that working-tree events started and that found the status equal: the
    /// repository panel re-reads its file dates on it (an edited file stays "modified" but moves up in Last update).
    @Published public private(set) var reads = 0
    private var watch: DispatchSourceFileSystemObject?
    private var workingTree: DirectoryWatcher?
    private var pending: DispatchWorkItem?
    /// The waiting refresh wakes the followers (a save or a host asked for it, not only file events).
    private var pendingWake = false
    /// When the git-folder events the waiting refresh collects began.
    private var burstStart: Date?
    private var loading = false
    private var again = false
    /// A read asked for by a save, a host or a retry wakes the followers even when the status comes back equal. A
    /// read started by file events (the working tree, git's own folder) wakes them only for a changed status or HEAD:
    /// each wake reloads every open note's agent blame, gutter and history and the panel's lists, and most git-folder
    /// events (another session's `git status` refreshing the index, a lock file, a fetch) change neither.
    private var wake = false
    /// The wake a read queued behind the running one asked for.
    private var againWake = false
    private var lastLoad = Date.distantPast
    /// A file's state and the line counts, run once per read for every view that asks.
    private let fileStates = GitReadShare<String, GitFileState?>()
    private let lineCountShare = GitReadShare<String, [String: GitLineCount]>()

    /// The longest a burst of git-folder events holds its refresh back. Each event moves the refresh to a quarter
    /// second after it (a commit writes the index several times), so a burst costs one status; other sessions' git
    /// runs that never stop still read the status once per this interval.
    nonisolated(unsafe) public static var gitFolderMaxWait: TimeInterval = 2

    /// The least time between two refreshes that working-tree file events start. Before it, an edit by another
    /// program never reached the panel: the status and its dates stayed as the last git event left them, hours old
    /// (Martin, 2026-10-25: "Last update" showed a note from 5 h ago while agents wrote files every minute).
    nonisolated(unsafe) public static var workingTreeInterval: TimeInterval = 3

    init(root: URL) {
        self.root = root
        load()
        let gitFolder = root.appendingPathComponent(".git").path
        workingTree = DirectoryWatcher(paths: [root.path], latency: 1, fileEvents: false,
                                       accepts: { $0 != gitFolder && !$0.hasPrefix(gitFolder + "/") }) { [weak self] _ in
            self?.workingTreeChanged()
        }
        let provider = GenesisKitGT.provider
        DispatchQueue.global(qos: .utility).async { [root] in
            let result = try? provider.git(["rev-parse", "--absolute-git-dir"], in: root, input: nil, gitDirectory: nil, environment: nil)
            let gitDir = result.flatMap { $0.status == 0 ? String(decoding: $0.stdout, as: UTF8.self).trimmed : nil }
            DispatchQueue.main.async { [weak self] in
                if let gitDir, !gitDir.isEmpty { self?.watch(gitDir) }
            }
        }
    }

    deinit {
        watch?.cancel()
        workingTree?.stop()
    }

    /// Reads the status now: the Try again of a failed read.
    public func retry() {
        pending?.cancel()
        pending = nil
        pendingWake = false
        burstStart = nil
        load()
    }

    /// Files changed in the working tree: a refresh, but no sooner than `workingTreeInterval` after the last one, so
    /// an agent writing a file a second costs one status every few seconds.
    private func workingTreeChanged() {
        guard pending == nil else { return }
        schedule(after: max(0.25, Self.workingTreeInterval - Date().timeIntervalSince(lastLoad)), wake: false)
    }

    /// git's own folder changed: a refresh a quarter second after the last event of the burst, at most
    /// `gitFolderMaxWait` after its first.
    private func gitFolderChanged() {
        let now = Date()
        let start = burstStart ?? now
        burstStart = start
        schedule(after: max(0, min(0.25, Self.gitFolderMaxWait - now.timeIntervalSince(start))), wake: false)
    }

    /// A refresh a quarter second after the last call, which wakes every follower (a save, a host's request).
    public func refresh() {
        schedule(after: 0.25, wake: true)
    }

    /// The one waiting refresh, moved to `wait` from now; it keeps a wake an earlier request asked for.
    private func schedule(after wait: TimeInterval, wake: Bool) {
        pending?.cancel()
        pendingWake = pendingWake || wake
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let wake = self.pendingWake
            self.pending = nil
            self.pendingWake = false
            self.burstStart = nil
            self.load(wake: wake)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    }

    private func load(wake: Bool = true) {
        guard !loading else {
            again = true
            againWake = againWake || wake
            return
        }
        self.wake = wake
        loading = true
        lastLoad = Date()
        let provider = GenesisKitGT.provider
        let root = self.root
        DispatchQueue.global(qos: .utility).async {
            let span = PerfSpans.begin("git.repoStatus", root.lastPathComponent)
            let read = Result { try provider.repoStatus(root, commits: 0) }
            span.end()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.loading = false
                switch read {
                case .success(let status):
                    if self.failure != nil { self.failure = nil }
                    if self.status != status {
                        self.status = status
                        self.wake = true
                    }
                case .failure(let error):
                    // The last good list stays: a locked index or a slow disk must not blank the panel.
                    GenesisKit.log("git: status of \(root.lastPathComponent) failed: \(error)")
                    self.failure = GitFailure(error, fallback: "Could not read this repository's status. Try again.")
                }
                if self.wake || self.failure != nil {
                    self.generation += 1
                }
                self.reads += 1
                if self.again {
                    let wake = self.againWake
                    self.again = false
                    self.againWake = false
                    self.load(wake: wake)
                }
            }
        }
    }

    /// `file`'s state from this read's status, run once for every view that asks during the read; nil before the
    /// first status.
    func fileState(of file: URL, _ done: @escaping (GitFileState?) -> Void) {
        guard let status else { return done(nil) }
        let provider = GenesisKitGT.provider
        fileStates.ask(file.standardizedFileURL.path, read: reads, compute: {
            (try? GitQueries(provider: provider).fileState(file, in: status)) ?? nil
        }, done: done)
    }

    /// Every tracked file's lines against HEAD (one `git diff --numstat`), once per read for every view that asks.
    func lineCounts(_ done: @escaping ([String: GitLineCount]) -> Void) {
        let provider = GenesisKitGT.provider
        let root = root
        lineCountShare.ask("", read: reads, compute: { GitQueries(provider: provider).numstat(in: root) }, done: done)
    }

    /// The git folder itself: the index and HEAD are replaced by a rename, which is a write to their folder.
    private func watch(_ gitDir: String) {
        let fd = open(gitDir, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in self?.gitFolderChanged() }
        source.setCancelHandler { close(fd) }
        source.resume()
        watch = source
    }
}

/// Calls `changed` whenever the repository holding a file refreshes its status, once at the start too unless
/// `skipFirst` (a start is also another file in the same folder, whose model cleared its state and waits for that
/// call); finds the repository first when it is not known yet. One per model that follows a file.
@MainActor
public final class GitRepoFollower {
    private var folder: URL?
    private var repo: AnyCancellable?
    private var repos: AnyCancellable?
    private let skipFirst: Bool
    private let contentChanges: Bool
    private let changed: () -> Void

    /// Content-derived readers also reload on working-tree reads whose porcelain status stayed equal.
    /// History readers keep the default, following only status/index/HEAD invalidation.
    public init(skipFirst: Bool = false, contentChanges: Bool = false, changed: @escaping () -> Void) {
        self.skipFirst = skipFirst
        self.contentChanges = contentChanges
        self.changed = changed
    }

    /// Follows the repository of the file `url` (nil: none).
    public func follow(_ url: URL?) {
        follow(folder: url?.deletingLastPathComponent())
    }

    /// Follows the repository holding `folder` (nil: none).
    public func follow(folder: URL?) {
        guard folder != self.folder else {
            if !skipFirst, repo != nil { changed() }
            return
        }
        self.folder = folder
        repo = nil
        repos = nil
        guard folder != nil, !attach() else { return }
        // Not known yet: its lookup bumps `GitRepos.revision`.
        repos = GitRepos.shared.$revision.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.attach() else { return }
                self.repos = nil
            }
        }
    }

    private func attach() -> Bool {
        if repo != nil { return true }
        guard let folder, let model = GitRepos.shared.model(for: folder) else { return false }
        let changes = contentChanges ? model.$reads.eraseToAnyPublisher() : model.$generation.eraseToAnyPublisher()
        let updates = skipFirst ? changes.dropFirst().eraseToAnyPublisher() : changes
        repo = updates.sink { [weak self] _ in
            DispatchQueue.main.async { self?.changed() }
        }
        return true
    }
}

/// One file's git state with its line counts, for the file on screen: loaded off the main thread, again when its
/// repository's status changes or the file is saved.
@MainActor
public final class GitFileStateModel: ObservableObject {
    @Published public private(set) var state: GitFileState?
    public private(set) var url: URL?
    private lazy var follower = GitRepoFollower(contentChanges: true) { [weak self] in self?.refresh() }
    private var ticket = 0

    public init() {}

    /// Follows `url` (nil: nothing).
    public func follow(_ url: URL?) {
        guard url != self.url else { return }
        self.url = url
        state = nil
        follower.follow(url)
    }

    /// Derived from the repository's shared status: no git run of its own but the line counts of a changed file,
    /// shared with every other view of the same file.
    public func refresh() {
        guard let url, let repo = GitRepos.shared.model(for: url.deletingLastPathComponent()), repo.status != nil else { return }
        ticket += 1
        let ticket = self.ticket
        repo.fileState(of: url) { [weak self] state in
            guard let self, self.ticket == ticket, self.url == url else { return }
            self.state = state
        }
    }
}

/// A file tree's git marks, kept current: the decorations of the repository holding the tree's root, spelled under
/// that root. None outside a repository.
@MainActor
public final class GitTreeDecorationsModel: ObservableObject {
    @Published public private(set) var decorations = GitTreeDecorations.none
    @Published private(set) var hasRepository = false
    private var root: URL?
    private lazy var follower = GitRepoFollower(contentChanges: true) { [weak self] in self?.update() }

    public init() {}

    public func follow(_ root: URL?) {
        guard root != self.root else { return }
        self.root = root
        ticket += 1
        counts = [:]
        hasRepository = false
        decorations = .none
        follower.follow(folder: root)
    }

    private var counts: [String: GitLineCount] = [:]
    private var ticket = 0

    /// The marks with the last counts, then the line counts from one `git diff --numstat` and the marks again: all built
    /// and compared off the main thread. Built on it, one refresh of a vault's status (1,825 entries) held the main
    /// thread about 250 ms in a debug build, at every git change, every start and every move of the tree's root
    /// (2026-10-14, 24% of the main thread in MarkdownTreeLagBenchTests).
    private func update() {
        guard let root, let repo = GitRepos.shared.model(for: root) else { return }
        hasRepository = true
        guard let status = repo.status else { return }
        ticket += 1
        let ticket = ticket
        let counts = counts
        let shown = decorations
        // The marks with the last counts show first, unless the fresh counts are already on screen.
        var recounted = false
        DispatchQueue.global(qos: .utility).async {
            let marked = status.decorations(under: root, numstat: counts)
            guard marked != shown else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket, self.root == root, !recounted else { return }
                self.decorations = marked
            }
        }
        // The counts come from one `git diff --numstat` per read, shared by every tree of the repository.
        repo.lineCounts { [weak self] fresh in
            guard let self, self.ticket == ticket, self.root == root else { return }
            DispatchQueue.global(qos: .utility).async {
                let marks = status.decorations(under: root, numstat: fresh)
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.ticket == ticket, self.root == root else { return }
                    recounted = true
                    self.counts = fresh
                    if marks != self.decorations { self.decorations = marks }
                }
            }
        }
    }
}

/// One answer per key and per read of a repository, for every view that asks: the first ask runs `compute` off the
/// main thread, the others of the same read wait for it. An ask for a newer read than the one running gets the
/// running answer and then the newer one.
@MainActor
final class GitReadShare<Key: Hashable, Value> {
    private struct Waiter {
        let read: Int
        let done: (Value) -> Void
    }

    private var answers: [Key: (read: Int, value: Value)] = [:]
    private var running: [Key: Int] = [:]
    private var waiting: [Key: [Waiter]] = [:]
    private var latest: [Key: (read: Int, compute: @Sendable () -> Value)] = [:]

    func ask(_ key: Key, read: Int, compute: @escaping @Sendable () -> Value, done: @escaping (Value) -> Void) {
        if let answer = answers[key], answer.read >= read { return done(answer.value) }
        waiting[key, default: []].append(Waiter(read: read, done: done))
        if (latest[key]?.read ?? .min) <= read { latest[key] = (read, compute) }
        if running[key] == nil { start(key) }
    }

    private func start(_ key: Key) {
        guard let (read, compute) = latest[key] else { return }
        running[key] = read
        DispatchQueue.global(qos: .utility).async {
            let value = compute()
            DispatchQueue.main.async { [weak self] in self?.finish(key, read: read, value: value) }
        }
    }

    private func finish(_ key: Key, read: Int, value: Value) {
        running[key] = nil
        answers[key] = (read, value)
        let waiters = waiting.removeValue(forKey: key) ?? []
        for waiter in waiters { waiter.done(value) }
        // A view that asked for a newer read gets that one too.
        let newer = waiters.filter { $0.read > read }
        if !newer.isEmpty {
            waiting[key] = newer
            start(key)
        } else {
            latest[key] = nil
        }
    }
}
