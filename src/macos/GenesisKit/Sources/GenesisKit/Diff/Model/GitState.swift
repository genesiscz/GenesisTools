//
//  GitState.swift
//  GenesisKit
//
//  What the git components show about a file and its repository: the file's state, a version of it, its commits,
//  and the repository's branch, changed files and recent commits. Plain values, filled by `GenesisKitGT.provider`.
//

import Foundation

/// A revision a file's text can be read at.
public enum GitRevision: Hashable, Sendable {
    case head
    /// The staged copy.
    case index
    case commit(String)

    /// `git show` object name for `path` (repo-relative) at this revision.
    public func object(for path: String) -> String {
        switch self {
        case .head: return "HEAD:\(path)"
        case .index: return ":\(path)"
        case .commit(let sha): return "\(sha):\(path)"
        }
    }
}

/// What happened to a path on one side of `git status` (the index, or the working tree).
public enum GitChangeKind: String, Hashable, Sendable {
    case modified, added, deleted, renamed, untracked, conflicted

    /// The letter a file list shows: M, A, D, R, U (untracked), C (conflict).
    public var letter: String {
        switch self {
        case .modified: return "M"
        case .added: return "A"
        case .deleted: return "D"
        case .renamed: return "R"
        case .untracked: return "U"
        case .conflicted: return "C"
        }
    }

    /// `git status --porcelain=v2` X or Y: nil for `.` (unchanged).
    public init?(porcelain letter: Character) {
        switch letter {
        case "M", "T": self = .modified
        case "A": self = .added
        case "D": self = .deleted
        case "R", "C": self = .renamed
        case "U": self = .conflicted
        default: return nil
        }
    }
}

/// One path of `git status`: its staged change, its unstaged change, or both.
public struct GitStatusEntry: Hashable, Sendable, Identifiable {
    /// Repo-relative.
    public var path: String
    public var oldPath: String?
    public var staged: GitChangeKind?
    public var unstaged: GitChangeKind?

    public var id: String { path }

    public init(path: String, oldPath: String? = nil, staged: GitChangeKind? = nil, unstaged: GitChangeKind? = nil) {
        self.path = path
        self.oldPath = oldPath
        self.staged = staged
        self.unstaged = unstaged
    }

    /// What a single badge shows: a conflict first, then the working tree's change, then the staged one.
    public var shown: GitChangeKind? {
        if staged == .conflicted || unstaged == .conflicted { return .conflicted }
        return unstaged ?? staged
    }
}

/// One file's place in git.
public struct GitFileState: Equatable, Sendable {
    public var repoRoot: URL
    /// Repo-relative.
    public var path: String
    /// "main", or "detached a1b2c3d".
    public var branch: String
    public var entry: GitStatusEntry?
    public var stagedAdditions = 0
    public var stagedDeletions = 0
    public var unstagedAdditions = 0
    public var unstagedDeletions = 0

    public init(repoRoot: URL, path: String, branch: String, entry: GitStatusEntry?) {
        self.repoRoot = repoRoot
        self.path = path
        self.branch = branch
        self.entry = entry
    }

    /// Tracked and unchanged.
    public var isClean: Bool { entry == nil }
    public var isUntracked: Bool { entry?.unstaged == .untracked }
    public var hasStaged: Bool { entry?.staged != nil && entry?.staged != .untracked }
    public var hasUnstaged: Bool { entry?.unstaged != nil }

    /// "Modified · 3 lines unstaged · 1 line staged", "new file, not in git", "" when clean.
    public var summary: String {
        guard let entry else { return "" }
        if isUntracked { return "new file, not in git" }
        if entry.unstaged == .renamed, entry.staged == nil, let old = entry.oldPath { return "Moved from \(old)" }
        if entry.shown == .conflicted { return "In conflict" }
        let word = (entry.shown ?? .modified).word
        var parts = [word.prefix(1).uppercased() + word.dropFirst()]
        let unstaged = unstagedAdditions + unstagedDeletions
        let staged = stagedAdditions + stagedDeletions
        if hasUnstaged { parts.append(unstaged > 0 ? "\(Plural.count(unstaged, "line")) unstaged" : "unstaged") }
        if hasStaged { parts.append(staged > 0 ? "\(Plural.count(staged, "line")) staged" : "staged") }
        return parts.joined(separator: " · ")
    }
}

/// A commit, as a history list shows it.
public struct GitCommit: Identifiable, Hashable, Sendable {
    public var sha: String
    public var short: String
    public var subject: String
    public var author: String
    public var date: Date
    /// The file's repo-relative path in this commit, for a history that follows renames.
    public var path: String?

    public var id: String { sha }

    public init(sha: String, short: String, subject: String, author: String, date: Date, path: String? = nil) {
        self.sha = sha
        self.short = short
        self.subject = subject
        self.author = author
        self.date = date
        self.path = path
    }
}

/// A repository's branch, its distance from upstream, its changed files and its recent commits.
public struct GitRepoStatus: Equatable, Sendable {
    public var root: URL
    public var branch: String
    public var upstream: String?
    public var ahead = 0
    public var behind = 0
    public var entries: [GitStatusEntry] = [] {
        didSet { byPath = Self.index(entries) }
    }
    public var commits: [GitCommit] = []
    /// Path → place in `entries`: the status bar's and the toolbar's marks ask on every render, and a search through a
    /// vault's 5,650 entries showed up in the repository panel's sort sample (2026-10-25).
    private var byPath: [String: Int] = [:]

    public init(root: URL, branch: String, upstream: String? = nil, ahead: Int = 0, behind: Int = 0, entries: [GitStatusEntry] = [], commits: [GitCommit] = []) {
        self.root = root
        self.branch = branch
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.entries = entries
        self.commits = commits
        byPath = Self.index(entries)
    }

    private static func index(_ entries: [GitStatusEntry]) -> [String: Int] {
        Dictionary(entries.enumerated().map { ($1.path, $0) }, uniquingKeysWith: { first, _ in first })
    }

    public static func == (lhs: GitRepoStatus, rhs: GitRepoStatus) -> Bool {
        lhs.root == rhs.root && lhs.branch == rhs.branch && lhs.upstream == rhs.upstream && lhs.ahead == rhs.ahead
            && lhs.behind == rhs.behind && lhs.entries == rhs.entries && lhs.commits == rhs.commits
    }

    /// The entry of a file in this repository, nil when the file is clean or outside it.
    public func entry(for file: URL) -> GitStatusEntry? {
        guard let path = GitQueries.relative(file, to: root), let index = byPath[path] else { return nil }
        return entries[index]
    }

    public var staged: [GitStatusEntry] { entries.filter { $0.staged != nil } }
    public var unstaged: [GitStatusEntry] { entries.filter { $0.unstaged != nil } }

    /// The decorations spelled under `treeRoot` as a file tree spells its paths: git names the repository by its
    /// real path (`/private/tmp`, a resolved link), a tree by the path it was given.
    /// `numstat`: repo-relative path to its lines against HEAD; each file's count is summed into its folders.
    public func decorations(under treeRoot: URL, numstat: [String: GitLineCount] = [:]) -> GitTreeDecorations {
        // Both sides through the same real path: Foundation's own link resolution drops /private, `realpath` keeps it.
        let given = treeRoot.standardizedFileURL.path
        let givenReal = GitWorkingTreeSource.realPath(given)
        let rootReal = GitWorkingTreeSource.realPath(root.standardizedFileURL.path)
        let inside = givenReal + "/"
        // Lengths once, and the folder walks cut at the last "/" in UTF-8: `String.count` walks every character, and
        // the walks asked it at every level of every entry (117 ms per call for a vault folder with 1,825 entries,
        // debug build, 2026-10-14).
        let realLength = givenReal.count
        let givenBytes = given.utf8.count
        var files: [String: GitChangeKind] = [:]
        var folders = Set<String>()
        var counts: [String: GitLineCount] = [:]
        for entry in entries {
            guard let kind = entry.shown else { continue }
            let real = rootReal + "/" + entry.path
            guard real.hasPrefix(inside) else { continue }
            let spelled = given + real.dropFirst(realLength)
            files[spelled] = kind
            var folder = Self.parent(of: spelled[...])
            while let current = folder, current.utf8.count > givenBytes, folders.insert(String(current)).inserted {
                folder = Self.parent(of: current)
            }
            guard let lines = numstat[entry.path] else { continue }
            counts[spelled] = lines
            var parent = Self.parent(of: spelled[...])
            while let current = parent, current.utf8.count > givenBytes {
                let key = String(current)
                let sum = counts[key] ?? GitLineCount(additions: 0, deletions: 0)
                counts[key] = GitLineCount(additions: sum.additions + lines.additions, deletions: sum.deletions + lines.deletions)
                parent = Self.parent(of: current)
            }
        }
        return GitTreeDecorations(files: files, folders: folders, counts: counts)
    }

    /// Everything before the last "/" (an absolute path's folder), nil when there is none.
    private static func parent(of path: Substring) -> Substring? {
        guard let slash = path.utf8.lastIndex(of: UInt8(ascii: "/")) else { return nil }
        return path[..<slash]
    }

    /// The change to show for each absolute path, and a mark for each folder that holds one: what a file tree
    /// decorates.
    public var decorations: GitTreeDecorations {
        var files: [String: GitChangeKind] = [:]
        var folders = Set<String>()
        let root = self.root.standardizedFileURL.path
        for entry in entries {
            guard let kind = entry.shown else { continue }
            let absolute = root + "/" + entry.path
            files[absolute] = kind
            var folder = (absolute as NSString).deletingLastPathComponent
            while folder.count > root.count, folders.insert(folder).inserted {
                folder = (folder as NSString).deletingLastPathComponent
            }
        }
        return GitTreeDecorations(files: files, folders: folders)
    }
}

/// What a file tree marks: a change per file path and the folders that hold changes (absolute paths).
/// Lines added and removed against HEAD (`git diff --numstat`); a folder's is the sum of its files'.
public struct GitLineCount: Equatable, Sendable {
    public var additions: Int
    public var deletions: Int

    public init(additions: Int, deletions: Int) {
        self.additions = additions
        self.deletions = deletions
    }
}

public struct GitTreeDecorations: Equatable, Sendable {
    public var files: [String: GitChangeKind]
    public var folders: Set<String>
    /// Per file and per folder, absolute as the tree spells them. Untracked files have none (no numstat).
    public var counts: [String: GitLineCount]

    public init(files: [String: GitChangeKind] = [:], folders: Set<String> = [], counts: [String: GitLineCount] = [:]) {
        self.files = files
        self.folders = folders
        self.counts = counts
    }

    public static let none = GitTreeDecorations()

    public func change(for path: String) -> GitChangeKind? { files[path] }
    public func holdsChanges(_ folder: String) -> Bool { folders.contains(folder) }
    public func count(for path: String) -> GitLineCount? { counts[path] }
}
