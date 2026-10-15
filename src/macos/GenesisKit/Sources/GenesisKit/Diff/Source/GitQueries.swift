//
//  GitQueries.swift
//  GenesisKit
//
//  The CLI provider's answers to the git components' questions, through `GenesisKitGTProvider.git`: a file's
//  state (`git status --porcelain=v2` plus `--numstat` counts), a version of it (`git show`), its history
//  (`git log --follow`), and the repository's status and recent commits.
//

import Foundation

struct GitQueries {
    let provider: GenesisKitGTProvider

    /// The repository root holding `folder`, or nil outside a repository.
    func root(of folder: URL) -> URL? {
        guard let result = try? provider.git(["rev-parse", "--show-toplevel"], in: folder, input: nil, gitDirectory: nil, environment: nil),
              result.status == 0 else { return nil }
        let path = String(decoding: result.stdout, as: UTF8.self).trimmed
        return path.isEmpty ? nil : URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    }

    /// `file` relative to `root`, through real paths (`/var` is `/private/var`).
    static func relative(_ file: URL, to root: URL) -> String? {
        let real = GitWorkingTreeSource.realPath(file.standardizedFileURL.path)
        let base = GitWorkingTreeSource.realPath(root.standardizedFileURL.path) + "/"
        return real.hasPrefix(base) ? String(real.dropFirst(base.count)) : nil
    }

    private func run(_ arguments: [String], in root: URL) throws -> String {
        let result = try provider.git(arguments, in: root, input: nil, gitDirectory: nil, environment: nil)
        guard result.status == 0 else {
            throw ReviewError.git("git \(arguments.joined(separator: " ")): \(String(decoding: result.stderr, as: UTF8.self).trimmed)")
        }
        return String(decoding: result.stdout, as: UTF8.self)
    }

    func fileState(_ file: URL) throws -> GitFileState? {
        guard let root = root(of: file.deletingLastPathComponent()), let path = Self.relative(file, to: root) else { return nil }
        let status = Self.parseStatus(try run(["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", path], in: root))
        var state = GitFileState(repoRoot: root, path: path, branch: status.branch, entry: status.entries.first { $0.path == path })
        if state.hasUnstaged, !state.isUntracked,
           let counts = Self.parseNumstat(try run(["--no-optional-locks", "diff", "--numstat", "--", path], in: root)) {
            state.unstagedAdditions = counts.additions
            state.unstagedDeletions = counts.deletions
        }
        if state.hasStaged, let counts = Self.parseNumstat(try run(["--no-optional-locks", "diff", "--cached", "--numstat", "--", path], in: root)) {
            state.stagedAdditions = counts.additions
            state.stagedDeletions = counts.deletions
        }
        return state
    }

    func contents(of file: URL, at revision: GitRevision) throws -> String? {
        guard let root = root(of: file.deletingLastPathComponent()), let path = Self.relative(file, to: root) else { return nil }
        return try contents(path: path, in: root, at: revision)
    }

    /// The text of a repo-relative path at a revision; nil when that revision has no such file or it is binary.
    func contents(path: String, in root: URL, at revision: GitRevision) throws -> String? {
        let result = try provider.git(["show", revision.object(for: path)], in: root, input: nil, gitDirectory: nil, environment: nil)
        guard result.status == 0, !result.stdout.prefix(8000).contains(0) else { return nil }
        return String(decoding: result.stdout, as: UTF8.self)
    }

    func history(of file: URL, limit: Int) throws -> [GitCommit] {
        guard let root = root(of: file.deletingLastPathComponent()), let path = Self.relative(file, to: root) else { return [] }
        let output = try run(["log", "--follow", "-n", String(limit), "--name-only", "--format=\u{1e}%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ct", "--", path], in: root)
        return Self.parseLog(output)
    }

    /// An explicit SHA is independent of the chooser's newest 30 commits. Follow the path's
    /// rename history too, and reject a commit that never changed this file.
    func pickedCommit(_ pick: String, of file: URL, in root: URL) throws -> GitCommit {
        guard pick.range(of: "^[0-9a-fA-F]{4,64}$", options: .regularExpression) != nil,
              let path = Self.relative(file, to: root) else { throw ReviewError.git("Invalid commit: \(pick)") }
        let sha = try run(["rev-parse", "--verify", "--end-of-options", "\(pick)^{commit}"], in: root).trimmed
        let format = "--format=\u{1e}%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ct"
        let direct = try run(["log", "--follow", "-1", "--name-only", format, sha, "--", path], in: root)
        if let commit = Self.parseLog(direct).first, commit.sha == sha { return commit }
        // A commit before the file's rename needs the path mapping from its current history.
        let output = try run(["log", "--follow", "--name-only", format, "--", path], in: root)
        guard let commit = Self.parseLog(output).first(where: { $0.sha == sha }) else {
            throw ReviewError.git("Commit \(pick) is not in this file's history.")
        }
        return commit
    }

    func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus? {
        guard let root = root(of: folder) else { return nil }
        let status = Self.parseStatus(try run(["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], in: root))
        let log = commits > 0 ? (try? run(["log", "-n", String(commits), "--format=\u{1e}%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ct"], in: root)) ?? "" : ""
        return GitRepoStatus(root: root, branch: status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind,
                             entries: status.entries, commits: Self.parseLog(log))
    }

    // MARK: Parsing

    struct Status {
        var branch = "(no branch)"
        var upstream: String?
        var ahead = 0
        var behind = 0
        var entries: [GitStatusEntry] = []
    }

    /// `git status --porcelain=v2 --branch -z`: `# branch.*` headers, then `1`, `2` (renamed: a second NUL field
    /// with the old path), `u` (unmerged) and `?` (untracked) entries.
    static func parseStatus(_ output: String) -> Status {
        var status = Status()
        var oid = ""
        let fields = output.split(separator: "\0", omittingEmptySubsequences: true).map(String.init)
        var index = 0
        while index < fields.count {
            let field = fields[index]
            index += 1
            if field.hasPrefix("# branch.oid ") {
                oid = String(field.dropFirst("# branch.oid ".count))
            } else if field.hasPrefix("# branch.head ") {
                let head = String(field.dropFirst("# branch.head ".count))
                status.branch = head == "(detached)" ? "detached \(oid.prefix(7))" : head
            } else if field.hasPrefix("# branch.upstream ") {
                status.upstream = String(field.dropFirst("# branch.upstream ".count))
            } else if field.hasPrefix("# branch.ab ") {
                let parts = field.dropFirst("# branch.ab ".count).split(separator: " ")
                if parts.count == 2 {
                    status.ahead = Int(parts[0].dropFirst()) ?? 0
                    status.behind = Int(parts[1].dropFirst()) ?? 0
                }
            } else if field.hasPrefix("? ") {
                status.entries.append(GitStatusEntry(path: String(field.dropFirst(2)), unstaged: .untracked))
            } else if field.hasPrefix("1 ") || field.hasPrefix("2 ") || field.hasPrefix("u ") {
                let kind = field.first
                // Fields before the path: 1 → 8, 2 → 9, u → 10; the path is the rest (it may hold spaces).
                let before = kind == "1" ? 8 : kind == "2" ? 9 : 10
                let parts = field.split(separator: " ", maxSplits: before, omittingEmptySubsequences: false)
                guard parts.count == before + 1 else { continue }
                let xy = Array(parts[1])
                let path = String(parts[before])
                var entry = GitStatusEntry(path: path)
                if kind == "u" {
                    entry.staged = .conflicted
                    entry.unstaged = .conflicted
                } else if xy.count == 2 {
                    entry.staged = GitChangeKind(porcelain: xy[0])
                    entry.unstaged = GitChangeKind(porcelain: xy[1])
                }
                if kind == "2", index < fields.count {
                    entry.oldPath = fields[index]
                    index += 1
                }
                status.entries.append(entry)
            }
        }
        return status
    }

    /// Every tracked file's lines against HEAD, repo-relative; empty for a repository without commits.
    func numstat(in root: URL) -> [String: GitLineCount] {
        guard let output = try? run(["--no-optional-locks", "diff", "--numstat", "-z", "HEAD"], in: root) else { return [:] }
        return Self.parseNumstatAll(output)
    }

    /// `git diff --numstat -z`: `add\tdel\tpath\0`, a rename `add\tdel\t\0old\0new\0` (keyed by the new path).
    /// Binary files report `-`, counted as 0.
    static func parseNumstatAll(_ output: String) -> [String: GitLineCount] {
        var counts: [String: GitLineCount] = [:]
        var fields = output.split(separator: "\0", omittingEmptySubsequences: false)[...]
        while let record = fields.popFirst() {
            let parts = record.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3 else { continue }
            let lines = GitLineCount(additions: Int(parts[0]) ?? 0, deletions: Int(parts[1]) ?? 0)
            if parts[2].isEmpty {
                _ = fields.popFirst()
                guard let new = fields.popFirst(), !new.isEmpty else { continue }
                counts[String(new)] = lines
            } else {
                counts[String(parts[2])] = lines
            }
        }
        return counts
    }

    /// `git diff --numstat` for one path: `add\tdel\tpath`. Binary files report `-`.
    static func parseNumstat(_ output: String) -> (additions: Int, deletions: Int)? {
        guard let line = output.split(separator: "\n").first else { return nil }
        let parts = line.split(separator: "\t", maxSplits: 2)
        guard parts.count >= 2 else { return nil }
        return (Int(parts[0]) ?? 0, Int(parts[1]) ?? 0)
    }

    /// Records that start with U+001E: `sha␟short␟subject␟author␟unix time`, then (with `--name-only`) a blank line
    /// and the path the commit touched.
    static func parseLog(_ output: String) -> [GitCommit] {
        output.split(separator: "\u{1e}", omittingEmptySubsequences: true).compactMap { record in
            let lines = record.split(separator: "\n", omittingEmptySubsequences: true)
            guard let header = lines.first else { return nil }
            let parts = header.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 5, let seconds = TimeInterval(parts[4]) else { return nil }
            return GitCommit(sha: parts[0], short: parts[1], subject: parts[2], author: parts[3],
                             date: Date(timeIntervalSince1970: seconds), path: lines.dropFirst().last.map(String.init))
        }
    }
}
