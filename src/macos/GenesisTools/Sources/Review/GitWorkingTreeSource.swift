import Foundation

/// What a diff compares, as in Codex's review menu. Every scope is a pair of sides: an "old"
/// revision and a "new" one, where the new side may be the working tree on disk.
enum DiffScope: Hashable {
    /// The session's last turn: needs the per-session change log (handoff h_p38uwgeo).
    case lastTurn
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
    /// Two commits, e.g. a PR's base..head from a review proposal.
    case range(base: String, head: String, label: String)

    var title: String {
        switch self {
        case .lastTurn: return "Last Turn"
        case .uncommitted: return "Uncommitted"
        case .unstaged: return "Unstaged"
        case .staged: return "Staged"
        case .commit(let sha, _): return String(sha.prefix(8))
        case .branch: return "Branch"
        case .range(_, _, let label): return label
        }
    }

    init?(argument: String) {
        switch argument {
        case "uncommitted": self = .uncommitted
        case "unstaged": self = .unstaged
        case "staged": self = .staged
        case "branch": self = .branch
        case "last-turn": self = .lastTurn
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
        case .uncommitted, .lastTurn:
            return ("HEAD", nil, ["HEAD"], true, nil)
        case .unstaged:
            return ("", nil, [], true, nil)
        case .staged:
            return ("HEAD", "", ["--cached", "HEAD"], false, nil)
        case .commit(let sha, _):
            let parent = (try? git(["rev-parse", "--verify", "--quiet", "\(sha)^"]).trimmed).flatMap { $0.isEmpty ? nil : $0 } ?? Self.emptyTree
            return (parent, sha, [parent, sha], false, nil)
        case .range(let base, let head, _):
            for sha in [base, head] where (try? git(["cat-file", "-e", "\(sha)^{commit}"])) == nil {
                throw ReviewError.git("commit \(sha.prefix(10)) is not in \(repo.path); fetch the PR branch first (git fetch origin <branch>)")
            }
            // What the PR/MR page shows: the head against its merge base, so commits that landed on the
            // base branch after the fork do not appear as reverse changes.
            let from = (try? git(["merge-base", base, head]).trimmed).flatMap { $0.isEmpty ? nil : $0 } ?? base
            return (from, head, [from, head], false, nil)
        case .branch:
            let base = baseBranch()
            let mergeBase = (try? git(["merge-base", base, "HEAD"]).trimmed) ?? "HEAD"
            return (mergeBase, nil, [mergeBase], true, base)
        }
    }

    func load(scope: DiffScope = .uncommitted) throws -> Snapshot {
        let branch = (try? git(["rev-parse", "--abbrev-ref", "HEAD"]).trimmed) ?? "(no HEAD)"
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
    func commits(limit: Int = 30) -> [RepoCommit] {
        let base = baseBranch()
        let range = base == "HEAD" ? ["HEAD"] : ["\(base)..HEAD"]
        let raw = (try? git(["log", "--format=%H%x1f%h%x1f%s%x1f%cr", "-n", String(limit)] + range)) ?? ""
        return raw.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4 else { return nil }
            return RepoCommit(sha: parts[0], short: parts[1], subject: parts[2], when: parts[3])
        }
    }

    // MARK: git

    private func gitData(_ args: [String], input: Data? = nil) throws -> Data {
        let span = HubPerf.begin("git.\(args.first ?? "")", repo.lastPathComponent)
        defer { span.end() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo.path, "-c", "core.quotepath=off"] + args
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
        guard !specs.isEmpty else { return [:] }
        let request = specs.map { "\($0.rev):\($0.path)\n" }.joined()
        guard let data = try? gitData(["cat-file", "--batch"], input: Data(request.utf8)) else { return [:] }

        var result: [String: Content] = [:]
        var cursor = data.startIndex
        for spec in specs {
            guard let newline = data[cursor...].firstIndex(of: 0x0A) else { break }
            let header = String(decoding: data[cursor..<newline], as: UTF8.self)
            cursor = data.index(after: newline)
            let fields = header.split(separator: " ")
            guard fields.count == 3, fields[1] == "blob", let size = Int(fields[2]) else { continue }
            let end = data.index(cursor, offsetBy: size)
            result["\(spec.rev):\(spec.path)"] = decode(data[cursor..<end], size: size)
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
