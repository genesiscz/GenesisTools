import Foundation

/// What a diff compares, as in Codex's review menu. Every scope is a pair of sides: an "old"
/// revision and a "new" one, where the new side may be the working tree on disk.
enum DiffScope: Hashable {
    /// The files the session's last `n` turns changed (the per-session change log, `tools agents
    /// changes --last-turns`), from before the first of those turns to the working tree now.
    case lastTurns(Int)
    /// HEAD vs working tree, untracked files included.
    case uncommitted
    /// Index vs working tree, untracked files included.
    case unstaged
    /// HEAD vs index.
    case staged
    /// One commit against its parent.
    case commit(sha: String, title: String)
    /// Merge base with the base branch vs working tree: everything this branch changes.
    case branch
    /// Two commits, e.g. a PR's base..head from a review proposal. `fallbackBase` is used when
    /// `base` is not in the repo (a PR's recorded base commit that was never fetched).
    case range(base: String, head: String, label: String, fallbackBase: String? = nil)
    /// Two pushes of a PR: `from`'s change replayed onto `to`'s base, against `to`'s head, so a rebase
    /// between them shows only what the author changed (Review/ReviewVersions.swift). `targetRef` gives
    /// an end without a recorded base its merge base (`origin/<target>`).
    case compare(from: CompareEnd, to: CompareEnd, label: String, targetRef: String? = nil)

    /// The commit the new side of the diff is pinned to: a commit, or a range whose head is not a
    /// name that moves (`HEAD`, a branch). nil for the working-tree scopes.
    var pinnedHead: String? {
        switch self {
        case .commit(let sha, _): return sha
        case .range(_, let head, _, _):
            let isCommitID = head.count >= 7 && head.allSatisfy(\.isHexDigit)
            return isCommitID ? head : nil
        case .compare(_, let to, _, _): return to.head
        default: return nil
        }
    }

    var title: String {
        switch self {
        case .lastTurns(let count): return count == 1 ? "Last Turn" : "Last \(count) Turns"
        case .uncommitted: return "Uncommitted"
        case .unstaged: return "Unstaged"
        case .staged: return "Staged"
        case .commit(let sha, _): return String(sha.prefix(8))
        case .branch: return "Branch"
        case .range(_, _, let label, _): return label
        case .compare(_, _, let label, _): return label
        }
    }

    /// Whether a change on disk can change this diff. A commit, or a range whose ends are commit ids, is
    /// fixed: no file event moves it, so the window does not load it again for one (a PR's range was
    /// re-read about three times a minute all night while agents wrote in its repository, 2026-09-30).
    /// A range on a name (`HEAD`, `origin/main`, a fallback base) moves with a commit or a fetch.
    var followsWorkingTree: Bool {
        switch self {
        case .commit, .compare: return false
        case .range(let base, let head, _, let fallbackBase):
            return !(Self.isObjectID(base) && Self.isObjectID(head) && (fallbackBase.map(Self.isObjectID) ?? true))
        default: return true
        }
    }

    /// A full or abbreviated commit id (7 to 64 hex digits), never a ref name.
    static func isObjectID(_ revision: String) -> Bool {
        (7...64).contains(revision.count) && revision.allSatisfy(\.isHexDigit)
    }

    init?(argument: String) {
        switch argument {
        case "uncommitted": self = .uncommitted
        case "unstaged": self = .unstaged
        case "staged": self = .staged
        case "branch": self = .branch
        case "last-turn": self = .lastTurns(1)
        default: return nil
        }
    }
}

struct RepoCommit: Identifiable, Hashable {
    var id: String { sha }
    var sha: String
    var short: String
    var subject: String
    var when: String
}

/// One checkout of the repository (`git worktree list`): the main one and every linked worktree.
struct RepoWorktree: Hashable {
    var path: String
    /// nil for a detached HEAD.
    var branch: String?
    var head: String

    /// "feat/x · checkout-folder", or the short head when detached.
    var title: String {
        "\(branch ?? "detached \(head.prefix(7))")  ·  \(URL(fileURLWithPath: path).lastPathComponent)"
    }

    /// `git worktree list --porcelain`: blocks of `worktree`, `HEAD`, `branch refs/heads/…` or `detached`.
    static func parse(_ porcelain: String) -> [RepoWorktree] {
        porcelain.components(separatedBy: "\n\n").compactMap { block in
            var path: String?
            var head = ""
            var branch: String?
            var bare = false
            for line in block.split(separator: "\n").map(String.init) {
                if line.hasPrefix("worktree ") { path = String(line.dropFirst("worktree ".count)) }
                if line.hasPrefix("HEAD ") { head = String(line.dropFirst("HEAD ".count)) }
                if line.hasPrefix("branch ") {
                    branch = String(line.dropFirst("branch ".count)).replacingOccurrences(of: "refs/heads/", with: "")
                }
                if line == "bare" { bare = true }
            }
            guard let path, !bare else { return nil }
            return RepoWorktree(path: path, branch: branch, head: head)
        }
    }
}

/// Where a reviewed repository lives: its root and Git directories, and which file events matter.
struct ReviewRepositoryLayout: Equatable {
    let root: URL
    let gitDirectory: URL
    let commonDirectory: URL

    var watchPaths: [String] { Array(Set([root.path, gitDirectory.path, commonDirectory.path])).sorted() }

    func matters(_ event: String) -> Bool {
        let path = URL(fileURLWithPath: event).standardizedFileURL.path
        for directory in [gitDirectory.path, commonDirectory.path] {
            if path == directory { return true }
            if path.hasPrefix(directory + "/") {
                let relative = String(path.dropFirst(directory.count + 1))
                return ["HEAD", "index", "packed-refs", "refs"].contains(relative) || relative.hasPrefix("refs/")
            }
        }
        guard path == root.path || path.hasPrefix(root.path + "/") else { return false }
        return !path.contains("/node_modules/") && !path.contains("/.build/")
    }
}

/// A repository's changes for one scope. Blob metadata is checked in batches before eligible
/// immutable objects are read, so excluded large blobs never enter the captured output.
struct GitWorkingTreeSource {
    struct Snapshot {
        var branch: String
        var base: String?
        var files: [DiffFile]
        var repository: ReviewRepositoryLayout? = nil
        var head: String? = nil
        /// A compare diff: paths the change and the upstream both touched; they show the older head's copy.
        var compareConflicts: [String] = []
    }

    static let maxBytes = 1_000_000
    static let emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

    let repo: URL
    /// The base the Branch scope compares against when it exists here: the PR's target branch
    /// (`origin/<target>`). Without it, a stacked PR's Branch diff ran against `origin/HEAD`.
    var preferredBase: String? = nil

    /// The old and new revisions of a scope. `nil` new side = the working tree on disk; `""` = the index.
    private func sides(_ scope: DiffScope) throws -> (old: String, new: String?, diffArgs: [String], untracked: Bool, base: String?) {
        switch scope {
        case .uncommitted, .lastTurns:
            return ("HEAD", nil, ["HEAD"], true, nil)
        case .unstaged:
            return ("", nil, [], true, nil)
        case .staged:
            return ("HEAD", "", ["--cached", "HEAD"], false, nil)
        case .commit(let sha, _):
            let parent = (try? git(["rev-parse", "--verify", "--quiet", "\(sha)^"]).trimmed).flatMap { $0.isEmpty ? nil : $0 } ?? Self.emptyTree
            return (parent, sha, [parent, sha], false, nil)
        case .range(let preferred, let head, _, let fallback):
            // A newer push of a PR (the window's Reload) is fetched by id when no ref brought it yet.
            if Self.isFullObjectID(head) { try? ensureCommit(head) }
            let base = [preferred, fallback].compactMap { $0 }.first { (try? git(["cat-file", "-e", "\($0)^{commit}"])) != nil } ?? preferred
            for sha in [base, head] where (try? git(["cat-file", "-e", "\(sha)^{commit}"])) == nil {
                throw ReviewError.git("commit \(sha.prefix(10)) is not in \(repo.path); fetch the PR branch first (git fetch origin <branch>)")
            }
            // What the PR/MR page shows: the head against its merge base, so commits that landed on the
            // base branch after the fork do not appear as reverse changes.
            let mergeBase = (try? git(["merge-base", base, head]).trimmed).flatMap { $0.isEmpty ? nil : $0 }
            if mergeBase == nil && base != preferred {
                // The recorded base is missing and the fallback shares no history with the head:
                // diffing the two would show two unrelated trees as the PR.
                throw ReviewError.git("the PR's base \(preferred.prefix(10)) is not in \(repo.path), and \(base) shares no history with \(head.prefix(10)); fetch the base branch first")
            }
            let from = mergeBase ?? base
            return (from, head, [from, head], false, nil)
        case .compare(let from, let to, _, let targetRef):
            let replayed = try compareTree(from: from, to: to, targetRef: targetRef)
            return (replayed.tree, to.head, [replayed.tree, to.head], false, nil)
        case .branch:
            let base = baseBranch()
            let mergeBase = (try? git(["merge-base", base, "HEAD"]).trimmed) ?? "HEAD"
            return (mergeBase, nil, [mergeBase], true, base)
        }
    }

    func repositoryLayout() throws -> ReviewRepositoryLayout {
        let output: String
        do {
            output = try git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"])
        } catch {
            if "\(error)".lowercased().contains("not a git repository") { throw ReviewError.notRepository(repo.path) }
            throw error
        }
        let paths = output.split(separator: "\n")
            .map { URL(fileURLWithPath: String($0)).resolvingSymlinksInPath().standardizedFileURL }
        guard paths.count == 3 else { throw ReviewError.notRepository(repo.path) }
        return ReviewRepositoryLayout(root: paths[0], gitDirectory: paths[1], commonDirectory: paths[2])
    }

    func load(scope: DiffScope = .uncommitted, session: String? = nil) throws -> Snapshot {
        let layout = try repositoryLayout()
        let source = GitWorkingTreeSource(repo: layout.root, preferredBase: preferredBase)
        var snapshot = try source.loadCanonical(scope: scope, session: session)
        snapshot.repository = layout
        switch scope {
        case .range(_, let head, _, _), .commit(let head, _):
            snapshot.head = try source.git(["rev-parse", "--verify", head]).trimmed
        case .compare(let from, let to, _, let targetRef):
            snapshot.head = try source.git(["rev-parse", "--verify", to.head]).trimmed
            snapshot.compareConflicts = try source.compareTree(from: from, to: to, targetRef: targetRef).conflicted
        default: break
        }
        return snapshot
    }

    private func loadCanonical(scope: DiffScope, session: String?) throws -> Snapshot {
        let branch: String
        do {
            branch = try git(["rev-parse", "--abbrev-ref", "HEAD"]).trimmed
        } catch {
            // A folder with a broken or empty .git: each later git call printed its usage text into the
            // pane ("Not a git repository. Use --no-index …", a codex session's folder, 2026-10-02).
            if "\(error)".lowercased().contains("not a git repository") {
                throw ReviewError.notRepository(repo.path)
            }
            branch = "(no HEAD)"
        }
        if case .lastTurns(let count) = scope {
            guard let session else {
                throw ReviewError.git("Last turns needs a session: open this diff from a session in the hub")
            }
            return try loadTurns(session: session, count: count, branch: branch)
        }
        let plan = try sides(scope)
        var entries = parseNameStatus(try gitData(["diff", "--name-status", "-z", "--find-renames"] + plan.diffArgs))
        if plan.untracked {
            let untracked = (try? gitData(["ls-files", "--full-name", "--others", "--exclude-standard", "-z"])) ?? Data()
            let known = Set(entries.map(\.path))
            entries += untracked.split(separator: 0).map { String(decoding: $0, as: UTF8.self) }
                .filter { !known.contains($0) }
                .map { StatusEntry(path: $0, oldPath: nil, status: .added) }
        }

        let counts = parseNumstat((try? gitData(["diff", "--numstat", "-z", "--find-renames"] + plan.diffArgs)) ?? Data())
        let olds = catFile(entries.filter { $0.status != .added }.map { (plan.old, $0.oldPath ?? $0.path) })
        let news: [String: Content] = plan.new.map { rev in
            catFile(entries.filter { $0.status != .deleted }.map { (rev, $0.path) })
        } ?? [:]

        let files: [DiffFile] = entries.map { entry in
            var file = DiffFile(
                id: entry.path,
                path: entry.path,
                oldPath: entry.oldPath,
                status: entry.status,
                additions: 0,
                deletions: 0,
                oldContents: nil,
                newContents: nil,
                skipped: nil
            )

            if entry.status != .added {
                switch olds["\(plan.old):\(entry.oldPath ?? entry.path)"] {
                case .text(let text): file.oldContents = text
                case .skipped(let why): file.skipped = why
                case nil: break
                }
            }

            if entry.status != .deleted {
                let content = plan.new.map { news["\($0):\(entry.path)"] } ?? readWorkingFile(entry.path)
                switch content {
                case .text(let text): file.newContents = text
                case .skipped(let why): file.skipped = why
                case nil: break
                }
            }

            if let count = counts[entry.path] {
                file.additions = count.additions
                file.deletions = count.deletions
            } else if entry.status == .added, let text = file.newContents {
                let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
                file.additions = text.hasSuffix("\n") ? lines - 1 : lines
            }

            return file
        }

        return Snapshot(branch: branch, base: plan.base, files: files.sorted { $0.path < $1.path })
    }

    /// `tools agents changes <session> --last-turns N --json` (src/agents/commands/changes.ts).
    struct TurnChanges: Decodable {
        struct File: Decodable {
            let path: String
            /// null for a file the turns created, and ALSO when nothing recorded the state before:
            /// then `skipped` is `no-before-state`.
            let beforeOid: String?
            let skipped: String?
        }

        let files: [File]
        let objects: String
    }

    /// What happened to a file the turns changed, with `exists` its presence in the working tree now.
    /// nil when there is nothing to show (created and removed again). A before-state nobody recorded
    /// is not a creation: that file existed, so it is modified (or deleted), never added.
    static func turnStatus(_ file: TurnChanges.File, exists: Bool) -> DiffFile.Status? {
        let unknownBefore = file.beforeOid == nil && file.skipped == "no-before-state"
        guard exists || file.beforeOid != nil || unknownBefore else { return nil }
        guard exists else { return .deleted }
        return file.beforeOid == nil && !unknownBefore ? .added : .modified
    }

    /// The last `count` turns' files inside this repository, each from its state before the first of
    /// those turns (a blob in the change log's object store) to the working tree now. A file the turns
    /// changed and then put back is left out. No turn with changes yet is an empty, ready snapshot.
    private func loadTurns(session: String, count: Int, branch: String) throws -> Snapshot {
        // `--store-blobs`: the before-states below come from the object store, and `changes` writes
        // them only when asked.
        let data = try ToolsCLIRunner.run(["agents", "changes", session, "--last-turns", String(count), "--json", "--store-blobs"])
        let log = try JSONDecoder().decode(TurnChanges.self, from: data)
        // Both sides as real paths: the log can hold /private/var/… for a repo opened as /var/…, or
        // the other way round through a symlinked folder, and a plain prefix test then drops every file.
        let root = Self.realPath(repo.standardizedFileURL.path) + "/"
        let inRepo: [(entry: TurnChanges.File, path: String)] = log.files.compactMap { entry in
            let real = Self.realPath(entry.path)
            return real.hasPrefix(root) ? (entry, real) : nil
        }
        let olds = catFileBatch(inRepo.compactMap(\.entry.beforeOid), gitDir: log.objects)
        let files: [DiffFile] = inRepo.compactMap { entry, absolute in
            let path = String(absolute.dropFirst(root.count))
            let exists = FileManager.default.fileExists(atPath: absolute)
            guard let status = Self.turnStatus(entry, exists: exists) else { return nil }

            var file = DiffFile(id: path, path: path, oldPath: nil, status: status,
                                additions: 0, deletions: 0, oldContents: nil, newContents: nil, skipped: entry.skipped)
            if let oid = entry.beforeOid {
                switch olds[oid] {
                case .text(let text): file.oldContents = text
                case .skipped(let why): file.skipped = why
                case nil: file.skipped = file.skipped ?? "before-state not in the change log"
                }
            }
            if exists {
                switch readWorkingFile(path) {
                case .text(let text): file.newContents = text
                case .skipped(let why): file.skipped = why
                }
            }
            if file.skipped == nil, file.oldContents == file.newContents {
                return nil
            }
            let counts = Self.lineCounts(old: file.oldContents ?? "", new: file.newContents ?? "")
            file.additions = counts.additions
            file.deletions = counts.deletions
            return file
        }

        HubPerf.log("review.lastTurns session=\(session.prefix(8)) turns=\(count) logged=\(log.files.count) inRepo=\(files.count)")
        return Snapshot(branch: branch, base: nil, files: files.sorted { $0.path < $1.path })
    }

    /// `path` with every symlink resolved (`/var` is `/private/var`). A part that no longer exists (a
    /// deleted file, its deleted folder) is kept as written under its resolved parent.
    static func realPath(_ path: String) -> String {
        if let real = realpath(path, nil) {
            defer { free(real) }
            return String(cString: real)
        }

        let parent = (path as NSString).deletingLastPathComponent
        guard !parent.isEmpty, parent != path else { return path }
        return (realPath(parent) as NSString).appendingPathComponent((path as NSString).lastPathComponent)
    }

    /// Added and removed lines between two texts (a Myers difference over lines).
    static func lineCounts(old: String, new: String) -> (additions: Int, deletions: Int) {
        let before = old.split(separator: "\n", omittingEmptySubsequences: false)
        let after = new.split(separator: "\n", omittingEmptySubsequences: false)
        var additions = 0
        var deletions = 0
        for change in after.difference(from: before) {
            switch change {
            case .insert: additions += 1
            case .remove: deletions += 1
            }
        }
        return (additions, deletions)
    }

    /// The branch this one will merge into: origin's default branch, else main/master.
    func baseBranch() -> String {
        if let preferredBase, (try? git(["rev-parse", "--verify", "--quiet", preferredBase])) != nil {
            return preferredBase
        }
        if let head = try? git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trimmed, !head.isEmpty {
            return head
        }

        for candidate in ["origin/master", "origin/main", "master", "main"] where (try? git(["rev-parse", "--verify", "--quiet", candidate])) != nil {
            return candidate
        }

        return "HEAD"
    }

    /// Every checkout of this repository, the main one first.
    func worktrees() -> [RepoWorktree] {
        RepoWorktree.parse((try? git(["worktree", "list", "--porcelain"])) ?? "")
    }

    /// Branches a diff can be compared against, the most recently committed first: local and remote.
    func baseCandidates(limit: Int = 30) -> [String] {
        let raw = (try? git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "--count=\(limit + 5)", "refs/heads", "refs/remotes"])) ?? ""
        // `refs/remotes/origin/HEAD` prints as "origin": a pointer, not a branch.
        let remotes = Set(((try? git(["remote"])) ?? "").split(separator: "\n").map(String.init))
        return Array(raw.split(separator: "\n").map(String.init)
            .filter { !remotes.contains($0) && !$0.hasSuffix("/HEAD") }
            .prefix(limit))
    }

    /// Commits on this branch that the base does not have (newest first), or the last `limit` commits.
    /// `range` replaces the checkout's `<base>..HEAD` (a PR whose head no checkout holds names its own).
    func commits(limit: Int = 30, range explicit: [String]? = nil) -> [RepoCommit] {
        let range = explicit ?? {
            let base = baseBranch()
            return base == "HEAD" ? ["HEAD"] : ["\(base)..HEAD"]
        }()
        let raw = (try? git(["log", "--format=%H%x1f%h%x1f%s%x1f%cr", "-n", String(limit)] + range)) ?? ""
        return raw.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4 else { return nil }
            return RepoCommit(sha: parts[0], short: parts[1], subject: parts[2], when: parts[3])
        }
    }

    // MARK: git

    /// `gitDir` runs against another repository's objects (the change log's store) instead of this one.
    private func gitData(_ args: [String], input: Data? = nil, gitDir: String? = nil) throws -> Data {
        let span = HubPerf.begin("git.\(args.first ?? "")", repo.lastPathComponent)
        defer { span.end() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        let location = gitDir.map { ["--git-dir", $0] } ?? ["-C", repo.path]
        process.arguments = location + ["-c", "core.quotepath=off"] + args
        let inPipe = Pipe()
        process.standardInput = input == nil ? FileHandle.nullDevice : inPipe
        let result = try process.runCapturing {
            guard let input else { return }
            // Feed stdin on its own queue: a large batch can fill the stdout pipe before stdin is drained.
            DispatchQueue.global().async {
                inPipe.fileHandleForWriting.write(input)
                try? inPipe.fileHandleForWriting.close()
            }
        }
        if result.status != 0 {
            let message = String(decoding: result.stderr, as: UTF8.self)
            throw ReviewError.git("git \(args.joined(separator: " ")): \(message.trimmed)")
        }

        return result.stdout
    }

    private func git(_ args: [String]) throws -> String {
        String(decoding: try gitData(args), as: UTF8.self)
    }

    static func isFullObjectID(_ revision: String) -> Bool {
        (40...64).contains(revision.count) && revision.allSatisfy(\.isHexDigit)
    }

    /// `git` that reports a non-zero exit instead of throwing on it (`allowFailure`), with extra environment.
    private func gitResult(_ args: [String], environment: [String: String]?, allowFailure: Bool) throws -> (status: Int32, stdout: String) {
        let span = HubPerf.begin("git.\(args.first ?? "")", repo.lastPathComponent)
        defer { span.end() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo.path, "-c", "core.quotepath=off"] + args
        if let environment {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        }
        process.standardInput = FileHandle.nullDevice
        let result = try process.runCapturing()
        if result.status != 0 && !allowFailure {
            let message = String(decoding: result.stderr, as: UTF8.self)
            throw ReviewError.git("git \(args.joined(separator: " ")): \(message.trimmed)")
        }
        return (result.status, String(decoding: result.stdout, as: UTF8.self))
    }

    /// The commit is here, or one fetch of it by id brings it (GitLab keeps every MR version's head).
    private func ensureCommit(_ sha: String) throws {
        if (try? git(["cat-file", "-e", "\(sha)^{commit}"])) != nil { return }
        // --no-write-fetch-head: a `git pull` running in this checkout reads FETCH_HEAD for what to merge.
        _ = try? git(["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "--end-of-options", "origin", sha])
        guard (try? git(["cat-file", "-e", "\(sha)^{commit}"])) != nil else {
            throw ReviewError.git("commit \(sha.prefix(10)) is not in \(repo.path), and fetching it from origin failed")
        }
    }

    /// The merge base an end's change starts from: its recorded base, else the merge base with `targetRef`.
    private func base(of end: CompareEnd, targetRef: String?) throws -> String {
        if let base = end.base {
            try ensureCommit(base)
            return base
        }
        guard let targetRef, let found = try? git(["merge-base", end.head, targetRef]).trimmed, !found.isEmpty else {
            throw ReviewError.git("no base for \(end.head.prefix(10)): the host named none and there is no target branch to take it from")
        }
        return found
    }

    /// `from`'s change on `to`'s base, cached per pair: the merge-tree runs once however often the diff loads.
    func compareTree(from: CompareEnd, to: CompareEnd, targetRef: String?) throws -> (tree: String, conflicted: [String]) {
        let key = "\(repo.path)|\(from.base ?? "-")|\(from.head)|\(to.base ?? "-")|\(to.head)|\(targetRef ?? "-")"
        if let cached = CompareTreeCache.shared.value(key) { return cached }
        try ensureCommit(from.head)
        try ensureCommit(to.head)
        let fromEnd = CompareEnd(base: try base(of: from, targetRef: targetRef), head: from.head)
        let toBase = try base(of: to, targetRef: targetRef)
        let replayed = try Self.replayedTree(from: fromEnd, toBase: toBase) { args, environment, allowFailure in
            try gitResult(args, environment: environment, allowFailure: allowFailure)
        }
        if !replayed.conflicted.isEmpty {
            HubPerf.log("review.compare \(from.head.prefix(8))→\(to.head.prefix(8)): \(replayed.conflicted.count) paths changed upstream too; they show the older head")
        }
        CompareTreeCache.shared.store(key, replayed)
        return replayed
    }

    // MARK: parsing

    private struct StatusEntry {
        var path: String
        var oldPath: String?
        var status: DiffFile.Status
    }

    /// `X\0path\0`, and for a rename or copy `R100\0old\0new\0`. One entry per path: during a merge
    /// conflict git can list a path twice (an unmerged `U` entry beside a regular one), and the path is
    /// the file's id.
    private func parseNameStatus(_ data: Data) -> [StatusEntry] {
        let tokens = data.split(separator: 0, omittingEmptySubsequences: true).map { String(decoding: $0, as: UTF8.self) }
        var entries: [StatusEntry] = []
        var seen = Set<String>()
        var index = 0
        while index < tokens.count {
            let code = tokens[index]
            index += 1
            guard let letter = code.first, index < tokens.count else { break }
            if letter == "R" || letter == "C", index + 1 < tokens.count {
                if seen.insert(tokens[index + 1]).inserted {
                    entries.append(StatusEntry(path: tokens[index + 1], oldPath: tokens[index], status: .renamed))
                }
                index += 2
                continue
            }

            let status: DiffFile.Status = letter == "A" ? .added : letter == "D" ? .deleted : .modified
            if seen.insert(tokens[index]).inserted {
                entries.append(StatusEntry(path: tokens[index], oldPath: nil, status: status))
            }
            index += 1
        }

        return entries
    }

    /// `add\tdel\tpath\0`, or for a rename `add\tdel\t\0old\0new\0`. Binary files report `-`.
    private func parseNumstat(_ data: Data) -> [String: (additions: Int, deletions: Int)] {
        let tokens = data.split(separator: 0, omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF8.self) }
        var counts: [String: (additions: Int, deletions: Int)] = [:]
        var index = 0
        while index < tokens.count {
            let parts = tokens[index].split(separator: "\t", omittingEmptySubsequences: false)
            index += 1
            guard parts.count == 3 else { continue }
            let additions = Int(parts[0]) ?? 0
            let deletions = Int(parts[1]) ?? 0
            var path = String(parts[2])
            if path.isEmpty, index + 1 < tokens.count {
                path = tokens[index + 1]
                index += 2
            }

            counts[path] = (additions, deletions)
        }

        return counts
    }

    private enum Content {
        case text(String)
        case skipped(String)
    }

    /// One `git cat-file --batch` for every `rev:path` (rev "" = the index): `<oid> blob <size>\n<bytes>\n`
    /// or `<name> missing\n`. Keys of the result are `rev:path`.
    private func catFile(_ specs: [(rev: String, path: String)]) -> [String: Content] {
        catFileBatch(specs.map { "\($0.rev):\($0.path)" })
    }

    /// One `git cat-file --batch` for these object names (`rev:path` or a bare oid), keyed by name.
    private func catFileBatch(_ names: [String], gitDir: String? = nil) -> [String: Content] {
        guard !names.isEmpty else { return [:] }
        let request = names.map { "\($0)\n" }.joined()
        guard let metadata = try? gitData(["cat-file", "--batch-check"], input: Data(request.utf8), gitDir: gitDir) else { return [:] }
        var result: [String: Content] = [:]
        var eligible: [(name: String, oid: String)] = []
        for (name, line) in zip(names, String(decoding: metadata, as: UTF8.self).split(separator: "\n")) {
            let fields = line.split(separator: " ")
            guard fields.count == 3, fields[1] == "blob", let size = Int(fields[2]), size >= 0 else { continue }
            if size > Self.maxBytes {
                result[name] = .skipped("large file, \(size / 1024) KB")
            } else {
                eligible.append((name, String(fields[0])))
            }
        }
        guard !eligible.isEmpty else { return result }
        let objects = eligible.map { "\($0.oid)\n" }.joined()
        guard let data = try? gitData(["cat-file", "--batch"], input: Data(objects.utf8), gitDir: gitDir) else { return result }

        var cursor = data.startIndex
        for (name, _) in eligible {
            guard let newline = data[cursor...].firstIndex(of: 0x0A) else { break }
            let header = String(decoding: data[cursor..<newline], as: UTF8.self)
            cursor = data.index(after: newline)
            let fields = header.split(separator: " ")
            guard fields.count == 3, fields[1] == "blob", let size = Int(fields[2]), size >= 0,
                  size < data.distance(from: cursor, to: data.endIndex) else { break }
            let end = data.index(cursor, offsetBy: size)
            result[name] = decode(data[cursor..<end], size: size)
            cursor = data.index(after: end)
        }

        return result
    }

    /// A symlink reads as its target path, which is what git stores in the blob; following it would
    /// diff the old target string against the new target's contents, or read outside the repository.
    private func readWorkingFile(_ path: String) -> Content {
        let url = repo.appendingPathComponent(path)
        if (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
            guard let target = try? FileManager.default.destinationOfSymbolicLink(atPath: url.path) else { return .skipped("unreadable") }
            return .text(target)
        }

        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= Self.maxBytes else { return .skipped("large file, \(size / 1024) KB") }
        guard let data = try? Data(contentsOf: url) else { return .skipped("unreadable") }
        return decode(data[...], size: data.count)
    }

    private func decode(_ bytes: Data.SubSequence, size: Int) -> Content {
        if size > Self.maxBytes {
            return .skipped("large file, \(size / 1024) KB")
        }

        if bytes.prefix(8000).contains(0) {
            return .skipped("binary file")
        }

        return .text(String(decoding: bytes, as: UTF8.self))
    }
}

enum ReviewError: Error, CustomStringConvertible {
    case git(String)
    case notRepository(String)

    var description: String {
        switch self {
        case .git(let message): return message
        case .notRepository(let path):
            return "\((path as NSString).abbreviatingWithTildeInPath) is not a git repository, so it has no changes to show."
        }
    }
}

extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
