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

    var title: String {
        switch self {
        case .lastTurns(let count): return count == 1 ? "Last Turn" : "Last \(count) Turns"
        case .uncommitted: return "Uncommitted"
        case .unstaged: return "Unstaged"
        case .staged: return "Staged"
        case .commit(let sha, _): return String(sha.prefix(8))
        case .branch: return "Branch"
        case .range(_, _, let label, _): return label
        }
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

/// A repository's changes for one `DiffScope`. Three or four git processes per load whatever the
/// file count: name-status, numstat, one `cat-file --batch` for every blob, plus untracked files
/// where the working tree is the new side.
struct GitWorkingTreeSource {
    struct Snapshot {
        var branch: String
        var base: String?
        var files: [DiffFile]
    }

    static let maxBytes = 1_000_000
    static let emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

    let repo: URL

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
        case .branch:
            let base = baseBranch()
            let mergeBase = (try? git(["merge-base", base, "HEAD"]).trimmed) ?? "HEAD"
            return (mergeBase, nil, [mergeBase], true, base)
        }
    }

    func load(scope: DiffScope = .uncommitted, session: String? = nil) throws -> Snapshot {
        let branch = (try? git(["rev-parse", "--abbrev-ref", "HEAD"]).trimmed) ?? "(no HEAD)"
        if case .lastTurns(let count) = scope {
            guard let session else {
                throw ReviewError.git("Last turns needs a session: open this diff from a session in the hub")
            }
            return try loadTurns(session: session, count: count, branch: branch)
        }
        let plan = try sides(scope)
        var entries = parseNameStatus(try gitData(["diff", "--name-status", "-z", "--find-renames"] + plan.diffArgs))
        if plan.untracked {
            let untracked = (try? gitData(["ls-files", "--others", "--exclude-standard", "-z"])) ?? Data()
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
        if let head = try? git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trimmed, !head.isEmpty {
            return head
        }

        for candidate in ["origin/master", "origin/main", "master", "main"] where (try? git(["rev-parse", "--verify", "--quiet", candidate])) != nil {
            return candidate
        }

        return "HEAD"
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
        guard let data = try? gitData(["cat-file", "--batch"], input: Data(request.utf8), gitDir: gitDir) else { return [:] }

        var result: [String: Content] = [:]
        var cursor = data.startIndex
        for name in names {
            guard let newline = data[cursor...].firstIndex(of: 0x0A) else { break }
            let header = String(decoding: data[cursor..<newline], as: UTF8.self)
            cursor = data.index(after: newline)
            let fields = header.split(separator: " ")
            guard fields.count == 3, fields[1] == "blob", let size = Int(fields[2]) else { continue }
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

    var description: String {
        switch self {
        case .git(let message): return message
        }
    }
}

extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
