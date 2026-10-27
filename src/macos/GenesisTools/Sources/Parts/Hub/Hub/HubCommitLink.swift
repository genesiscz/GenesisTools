import Foundation

// Commit links. `genesis-tools://hub?pr=<ref>&commit=<sha>` opens the PR and selects that commit in its review
// (`PRsModel.pickPendingCommit`), and `commit=<from>..<to>` selects that run of its commits, both ends included; `genesis-tools://hub?repo=<checkout path|owner/repo>&commit=<sha>` opens the
// commit in its project's Worktrees diff, as Activity's commit rows do (`HubModel.showCommit`). The browser-router
// preset `genesis-hub` turns `https://<link host>/hub?…` into the same link; `tools hub open --print-url` writes it.

/// A commit a link names: 7 to 40 hex characters, matched as a prefix of the full sha.
enum HubCommitSha {
    /// Lowercased, or nil when it is not 7 to 40 hex characters.
    static func normalized(_ raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard (7...40).contains(text.count), text.allSatisfy(\.isHexDigit) else { return nil }
        return text
    }

    /// The first of `commits` whose sha starts with `sha` (normalized).
    static func find(_ sha: String, in commits: [HubPRDetail.Commit]) -> HubPRDetail.Commit? {
        commits.first { $0.sha.lowercased().hasPrefix(sha) }
    }

    /// Whether the full sha `full` starts with `sha` (normalized), as `find` matches a list.
    static func matches(_ sha: String, _ full: String) -> Bool {
        full.lowercased().hasPrefix(sha)
    }

    static func invalid(_ raw: String) -> String {
        "\(raw.prefix(48)) is not a commit: a link names one by 7 to 40 hex characters, or a range as <from>..<to>"
    }
}

/// What a link's `commit=` names: one commit, or `<from>..<to>`, a run of commits with both ends included
/// (the diff from the parent of `from` to `to`). Each end is normalized (`HubCommitSha`).
struct HubCommitSpan: Equatable {
    let from: String
    /// Nil for one commit.
    let to: String?

    init(from: String, to: String? = nil) {
        self.from = from
        self.to = to
    }

    init?(_ raw: String) {
        let ends = raw.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "..")
        switch ends.count {
        case 1:
            guard let one = HubCommitSha.normalized(ends[0]) else { return nil }
            self.init(from: one)
        case 2:
            guard let from = HubCommitSha.normalized(ends[0]), let to = HubCommitSha.normalized(ends[1]) else { return nil }
            self.init(from: from, to: to)
        default:
            return nil
        }
    }

    var label: String { to.map { "\(from.prefix(10))..\($0.prefix(10))" } ?? String(from.prefix(10)) }
}

/// A commit, or a range of commits, to select in one PR's review (`PRsModel.request(_:commit:)`).
struct PRCommitPick: Equatable {
    let ref: HubPRRef
    /// Normalized (`HubCommitSha`): a prefix of the commit's sha; the range's first commit.
    let sha: String
    /// The range's last commit, nil for one commit.
    var to: String? = nil
    /// When it was asked: only a detail fetched after this can say the PR does not hold the commit.
    let asked: Date
}

/// A message about one PR for its header (`PRsModel.notice`): a link's commit it does not hold.
struct PRNotice: Equatable {
    let ref: HubPRRef
    let text: String
    /// False for a note that the link worked another way (its commits are local only).
    var isError = true
}

/// A link's commits that the forge does not list yet: an agent links its own commits before it pushes them, so
/// they exist only in the PR's checkout (2026-10-23: a range ending in four local commits
/// opened the whole MR). Read from that checkout's git, off the main thread.
struct HubLocalCommits: Equatable {
    /// Full shas, oldest first; `last` is nil for one commit.
    let first: String
    let last: String?
    /// The commits the range holds, both ends included, and how many of them the PR's pushed head lacks.
    let count: Int
    let unpushed: Int
    let title: String

    enum Miss: Error, Equatable {
        /// The checkout does not have this end either.
        case unknown(String)
        /// Both ends exist, but neither descends from the other.
        case unrelated
        /// The commits do not continue the PR: the last one does not descend from its pushed head, or the first one is
        /// neither one of its commits nor after that head (a commit from before the PR would show the base's changes).
        case offBranch
    }

    /// `ends` are the link's normalized shas, `head` the PR's pushed head and `pushed` the shas the forge lists for it.
    /// Runs git, so never on the main thread.
    nonisolated static func resolve(ends: [String], repo: String, head: String, pushed: Set<String> = []) -> Result<HubLocalCommits, Miss> {
        var full: [String] = []
        for end in ends {
            guard let sha = git(repo, ["rev-parse", "--verify", "--quiet", end + "^{commit}"])?
                .trimmingCharacters(in: .whitespacesAndNewlines), !sha.isEmpty else { return .failure(.unknown(end)) }
            full.append(sha)
        }
        var first = full[0]
        var last = full.count > 1 ? full[1] : full[0]
        if first != last, !isAncestor(first, of: last, repo: repo) {
            guard isAncestor(last, of: first, repo: repo) else { return .failure(.unrelated) }
            swap(&first, &last)
        }
        guard isAncestor(head, of: last, repo: repo),
              pushed.contains(first) || isAncestor(head, of: first, repo: repo) else {
            return .failure(.offBranch)
        }
        let span = Int(git(repo, ["rev-list", "--count", "--ancestry-path", first + ".." + last])?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        // Count only descendants of the first endpoint within this link, excluding the pushed head's history.
        // The exclusive range omits the first endpoint itself, so include it when it is also unpushed.
        let unpushedAfterFirst = Int(git(repo, ["rev-list", "--count", "--ancestry-path=" + first, first + ".." + last, "--not", head])?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        let unpushed = unpushedAfterFirst + (isAncestor(first, of: head, repo: repo) ? 0 : 1)
        let title = git(repo, ["log", "-1", "--format=%s", last])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .success(HubLocalCommits(first: first, last: full.count > 1 ? last : nil, count: span + 1,
                                        unpushed: unpushed, title: title))
    }

    nonisolated private static func isAncestor(_ older: String, of newer: String, repo: String) -> Bool {
        git(repo, ["merge-base", "--is-ancestor", older, newer]) != nil
    }

    nonisolated private static func git(_ repo: String, _ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo, "--no-optional-locks"] + args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}

/// The commit row a PR overview scrolls to once (`PRsModel.commitScroll`).
struct PRCommitScroll: Equatable {
    let prID: String
    let sha: String
    /// Two links to one commit scroll twice.
    let id = UUID()
}

/// The checkout, full sha and subject of a `repo=…&commit=…` link's commit.
enum HubCommitLookup {
    struct Found: Equatable {
        let root: String
        let sha: String
        let title: String
        /// For a range: the parent of its first commit, so the diff shows every commit of it.
        var base: String? = nil
    }

    enum Outcome: Equatable {
        case found(Found)
        case failed(String)
    }

    /// `repo` is a checkout path (any folder inside it), or a forge path such as `owner/repo` that `known` (else a
    /// fresh `tools hub pr projects`) maps to its checkout. Runs git, so off the main thread.
    static func resolve(repo: String, sha: String, to: String? = nil, known: [HubPRProject]) -> Outcome {
        let text = repo.trimmingCharacters(in: .whitespacesAndNewlines)
        let folder: String
        if text.hasPrefix("/") || text.hasPrefix("~") {
            folder = (text as NSString).expandingTildeInPath
        } else {
            let projects: [HubPRProject]
            do {
                projects = known.isEmpty ? try PRsModel.fetchProjects() : known
            } catch {
                return .failed("Could not list the projects to find \(text): \(error)")
            }
            let shas = [sha] + (to.map { [$0] } ?? [])
            // The checkout of the path the link names, while it holds the link's commits; else a fork that does.
            // With neither, that checkout still answers, so the miss names where the commit was looked for.
            let exact = PRsModel.projectRoot(text, in: projects)
            guard let root = exact.flatMap({ holds($0, shas) ? $0 : nil }) ?? sameName(text, holding: shas, in: projects) ?? exact else {
                return .failed("No checkout of \(text) under the repo roots, so commit \(sha) cannot open")
            }
            folder = root
        }
        guard FileManager.default.fileExists(atPath: folder) else {
            return .failed("\(folder) is not on this Mac")
        }
        guard let root = WorktreeDiscovery.git(folder, ["rev-parse", "--show-toplevel"])?.trimmed, !root.isEmpty else {
            return .failed("\(folder) is not a git checkout")
        }
        let place = (root as NSString).abbreviatingWithTildeInPath
        guard let line = WorktreeDiscovery.git(root, ["show", "-s", "--format=%H%x00%s", "\(sha)^{commit}", "--"])?.trimmed,
              let separator = line.firstIndex(of: "\0") else {
            return .failed("Commit \(sha) is not in \(place) (fetch it first)")
        }
        let first = String(line[..<separator])
        guard let to else {
            return .found(Found(root: root, sha: first, title: String(line[line.index(after: separator)...])))
        }
        guard let last = WorktreeDiscovery.git(root, ["rev-parse", "--verify", "--quiet", "\(to)^{commit}"])?.trimmed, !last.isEmpty else {
            return .failed("Commit \(to) is not in \(place) (fetch it first)")
        }
        // Either order: the older end is the one the other descends from.
        let ordered = WorktreeDiscovery.git(root, ["merge-base", "--is-ancestor", first, last]) != nil ? (first, last)
            : WorktreeDiscovery.git(root, ["merge-base", "--is-ancestor", last, first]) != nil ? (last, first) : nil
        guard let (older, newer) = ordered else {
            return .failed("\(sha) and \(to) are not on one line of history in \(place), so they make no range")
        }
        guard let base = parent(of: older, in: root) else {
            return .failed(missingParent(older, in: root))
        }
        let count = WorktreeDiscovery.git(root, ["rev-list", "--count", base == emptyTree ? newer : "\(base)..\(newer)"])?.trimmed ?? "?"
        let label = "\(older.prefix(10))..\(newer.prefix(10)) (\(count) commits)"
        return .found(Found(root: root, sha: newer, title: label, base: base))
    }

    /// The first parent of `sha` in the checkout at `root`, the base of a range that starts at `sha`: git's empty
    /// tree for a root commit, nil when a shallow clone only hides the parent (`missingParent`). Runs git, so off
    /// the main thread.
    static func parent(of sha: String, in root: String) -> String? {
        if let parent = WorktreeDiscovery.git(root, ["rev-parse", "--verify", "--quiet", "\(sha)^"])?.trimmed, !parent.isEmpty {
            return parent
        }
        // No parent: a root commit starts from the empty tree, but a shallow clone only hides the parent.
        return WorktreeDiscovery.git(root, ["rev-parse", "--is-shallow-repository"])?.trimmed == "false" ? emptyTree : nil
    }

    /// Why `parent(of:in:)` found no parent of `sha`.
    static func missingParent(_ sha: String, in root: String) -> String {
        "The parent of \(sha.prefix(10)) is not in \((root as NSString).abbreviatingWithTildeInPath), a shallow clone (fetch more history first)"
    }

    /// Whether the checkout at `root` holds every one of `shas` as a commit.
    static func holds(_ root: String, _ shas: [String]) -> Bool {
        shas.allSatisfy { sha in WorktreeDiscovery.git(root, ["cat-file", "-e", "\(sha)^{commit}"]) != nil }
    }

    /// A fork or a mirror: the link names one path (the upstream `group/sub/app`), the checkout clones another
    /// (`me/app`). The projects with the same last name are the candidates, and the first that holds every commit
    /// of the link (both ends of a range) wins.
    static func sameName(_ repo: String, holding shas: [String], in projects: [HubPRProject]) -> String? {
        let name = { (path: String) -> String in
            var last = path.lowercased().split(separator: "/").last.map(String.init) ?? ""
            if last.hasSuffix(".git") { last.removeLast(4) }
            return last
        }
        let wanted = name(repo)
        guard !wanted.isEmpty else { return nil }
        return projects.first { candidate in
            name(candidate.project) == wanted && holds(candidate.root, shas)
        }?.root
    }

    /// Git's empty tree: the base of a range that starts at a root commit (`GitWorkingTreeSource` diffs from it).
    static let emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
}

extension HubModel {
    @MainActor
    func applyCommitLink(_ outcome: HubCommitLookup.Outcome, request: UUID) {
        guard commitLinkRequest == request else { return }
        switch outcome {
        case .found(let found):
            showCommit(repo: found.root, sha: found.sha, title: found.title, base: found.base, link: commitLinkRaw)
        case .failed(let message):
            HubPerf.log("hub.commitLink \(message)")
            notice = message
        }
    }

    /// `--commit` without `--pr` (a link's `repo=…&commit=…`): the commit in its project's Worktrees diff. The
    /// checkout and the subject are read off the main thread; a miss is said in the notice, never dropped.
    @MainActor
    func openCommitLink(_ raw: String, repo: String?) {
        let request = UUID()
        commitLinkRequest = request
        guard let span = HubCommitSpan(raw) else {
            notice = HubCommitSha.invalid(raw)
            return
        }
        guard let repo, !repo.trimmed.isEmpty else {
            notice = "Commit \(span.label) needs its PR (pr=) or its project (repo=) to open"
            return
        }
        commitLinkRaw = span.to.map { "\(span.from)..\($0)" } ?? span.from
        cancelSessionNavigation()
        let known = prs.allProjects
        Task {
            let perf = HubPerf.begin("hub.commitLink", "\(repo) \(span.label)", awaits: true)
            let outcome = await Task.detached(priority: .userInitiated) {
                HubCommitLookup.resolve(repo: repo, sha: span.from, to: span.to, known: known)
            }.value
            perf.end("resolved")
            applyCommitLink(outcome, request: request)
        }
    }
}
