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
    /// Every completed refresh invalidates followers, even when HEAD or index changes leave status equal.
    @Published public private(set) var generation = 0
    private var watch: DispatchSourceFileSystemObject?
    private var workingTree: DirectoryWatcher?
    private var pending: DispatchWorkItem?
    private var loading = false
    private var again = false
    private var lastLoad = Date.distantPast

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
        load()
    }

    /// Files changed in the working tree: a refresh, but no sooner than `workingTreeInterval` after the last one, so
    /// an agent writing a file a second costs one status every few seconds.
    private func workingTreeChanged() {
        guard pending == nil else { return }
        let wait = max(0.25, Self.workingTreeInterval - Date().timeIntervalSince(lastLoad))
        let work = DispatchWorkItem { [weak self] in
            self?.pending = nil
            self?.load()
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    }

    /// A refresh a quarter second after the last call: a commit writes the index several times.
    public func refresh() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.pending = nil
            self?.load()
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func load() {
        guard !loading else {
            again = true
            return
        }
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
                    }
                case .failure(let error):
                    // The last good list stays: a locked index or a slow disk must not blank the panel.
                    GenesisKit.log("git: status of \(root.lastPathComponent) failed: \(error)")
                    self.failure = GitFailure(error, fallback: "Could not read this repository's status. Try again.")
                }
                self.generation += 1
                if self.again {
                    self.again = false
                    self.load()
                }
            }
        }
    }

    /// The git folder itself: the index and HEAD are replaced by a rename, which is a write to their folder.
    private func watch(_ gitDir: String) {
        let fd = open(gitDir, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in self?.refresh() }
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
    private let changed: () -> Void

    public init(skipFirst: Bool = false, changed: @escaping () -> Void) {
        self.skipFirst = skipFirst
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
        let generations = skipFirst ? model.$generation.dropFirst().eraseToAnyPublisher() : model.$generation.eraseToAnyPublisher()
        repo = generations.sink { [weak self] _ in
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
    private lazy var follower = GitRepoFollower { [weak self] in self?.refresh() }
    private var ticket = 0

    public init() {}

    /// Follows `url` (nil: nothing).
    public func follow(_ url: URL?) {
        guard url != self.url else { return }
        self.url = url
        state = nil
        follower.follow(url)
    }

    public func refresh() {
        guard let url else { return }
        ticket += 1
        let ticket = self.ticket
        let provider = GenesisKitGT.provider
        DispatchQueue.global(qos: .utility).async {
            let state = (try? provider.fileState(url)) ?? nil
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket, self.url == url else { return }
                self.state = state
            }
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
    private lazy var follower = GitRepoFollower { [weak self] in self?.update() }

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
        let provider = GenesisKitGT.provider
        let repoRoot = repo.root
        DispatchQueue.global(qos: .utility).async {
            let marked = status.decorations(under: root, numstat: counts)
            let markedChanged = marked != shown
            if markedChanged {
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.ticket == ticket, self.root == root else { return }
                    self.decorations = marked
                }
            }
            let fresh = GitQueries(provider: provider).numstat(in: repoRoot)
            let recounted = status.decorations(under: root, numstat: fresh)
            let recountChanged = recounted != (markedChanged ? marked : shown)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket, self.root == root else { return }
                self.counts = fresh
                if recountChanged { self.decorations = recounted }
            }
        }
    }
}
