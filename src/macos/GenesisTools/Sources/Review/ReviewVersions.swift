import Foundation

// The pushes of a PR/MR (`tools hub pr versions`): what a push after the diff on screen brought (the
// update notice and its Reload), and the two ends a "Compare versions" diff takes.
//
// A rebase moves a version onto a newer base, so `git diff oldHead newHead` shows every upstream
// commit the rebase brought in as the author's change (GitLab's own "compare versions" does the
// same). A compare diff instead replays the older version's change onto the newer version's base
// (`git merge-tree --merge-base`) and diffs that tree against the newer head: both sides then
// share the same upstream, and only what the author changed between the pushes is left.

struct PRVersionsPayload: Decodable, Equatable {
    let versions: [PRVersion]
    let history: Bool
}

struct PRVersion: Decodable, Identifiable, Equatable {
    struct Author: Decodable, Equatable {
        let name: String
        let username: String
        let avatarUrl: String?
    }

    struct Commit: Decodable, Equatable {
        let sha: String
        let title: String
        let author: String?
    }

    let id: String
    let headSha: String
    let baseSha: String?
    let createdAt: String?
    let pushedBy: Author?
    let commits: [Commit]
}

/// One end of a compare diff: a head and the merge base its change starts from (nil: the window
/// takes the merge base with the target branch, as GitHub names none).
struct CompareEnd: Hashable, Codable {
    var base: String?
    var head: String
}

/// What the pushes after the diff on screen brought, for the notice above the diff.
struct PRPushNews: Equatable {
    let newest: PRVersion
    /// The version whose head is on screen; nil when the host does not list it (a GitHub push without force).
    let shown: PRVersion?
    /// Pushes after the one on screen, the newest included.
    let pushes: Int
    /// Commits of the newest version whose titles the version on screen does not have.
    let newCommits: [PRVersion.Commit]
    /// The newest version starts from another merge base: the branch was rebased.
    let rebased: Bool

    /// nil when the newest version is the one on screen.
    static func between(shownHead: String, versions: [PRVersion]) -> PRPushNews? {
        guard let newest = versions.first, !PRThreadRendering.sameCommit(newest.headSha, shownHead) else { return nil }
        let shownIndex = versions.firstIndex { PRThreadRendering.sameCommit($0.headSha, shownHead) }
        let shown = shownIndex.map { versions[$0] }
        let rebased = shown.map { old in old.baseSha != nil && newest.baseSha != nil && old.baseSha != newest.baseSha } ?? false
        let known = Set(shown?.commits.map { rebased ? $0.title : $0.sha } ?? [])
        let fresh = shown == nil ? newest.commits : newest.commits.filter { !known.contains(rebased ? $0.title : $0.sha) }
        return PRPushNews(newest: newest, shown: shown, pushes: shownIndex ?? 1, newCommits: fresh, rebased: rebased)
    }

    /// "qkfoltynmar pushed 6 new commits · 17:53"; the time is local.
    var headline: String {
        let who = newest.pushedBy?.username ?? "Someone"
        let what: String
        if newCommits.isEmpty {
            what = rebased ? "rebased the branch" : "pushed"
        } else {
            let count = newCommits.count == 1 ? "1 new commit" : "\(newCommits.count) new commits"
            what = rebased ? "rebased and pushed \(count)" : "pushed \(count)"
        }
        let extra = pushes > 1 ? " (\(pushes) pushes)" : ""
        let when = newest.createdAt.flatMap(HubFormat.date).map { Self.clock.string(from: $0) }
        return "\(who) \(what)\(extra)" + (when.map { " · \($0)" } ?? "")
    }

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
}

/// `tools hub pr versions` for one PR, off the main thread. Loaded when the threads show a head
/// other than the diff's, and when the Compare picker opens; no timer.
final class PRVersionsStore: ObservableObject {
    let target: PRTarget
    @Published private(set) var payload: PRVersionsPayload?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    /// The PR head the last load answered for, so one push is asked about once.
    private(set) var loadedForHead: String?
    /// Called on the main thread after an answer lands.
    var onChange: (() -> Void)?
    private let loader: ([String]) throws -> PRVersionsPayload
    private var pendingLoad = false
    private var pendingHead: String?

    init(target: PRTarget, loader: @escaping ([String]) throws -> PRVersionsPayload = {
        try JSONDecoder().decode(PRVersionsPayload.self, from: PRCLI.run($0))
    }) {
        self.target = target
        self.loader = loader
    }

    func load(forHead head: String? = nil) {
        if loading {
            pendingLoad = true
            pendingHead = head
            return
        }
        if let head, head == loadedForHead, payload != nil { return }
        loading = true
        let args = ["hub", "pr", "versions"] + target.argv + ["--json"]
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("pr.versions", args.suffix(from: 3).joined(separator: " "))
            let result = Result { try self.loader(args) }
            span.end((try? result.get()).map { "\($0.versions.count) versions" } ?? "failed")
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.loading = false
                let retry = self.pendingLoad
                let retryHead = self.pendingHead
                self.pendingLoad = false
                self.pendingHead = nil
                switch result {
                case .success(let payload):
                    self.payload = payload
                    self.error = nil
                    self.loadedForHead = head ?? payload.versions.first?.headSha
                    self.onChange?()
                case .failure(let failure):
                    self.error = "\(failure)"
                    HubPerf.log("pr.versions failed: \(failure)")
                }
                if retry {
                    self.load(forHead: retryHead)
                }
            }
        }
    }
}

extension GitWorkingTreeSource {
    /// The tree of `from`'s change replayed onto `toBase`: `from.head` itself when both start from the
    /// same base. A path both the change and the upstream touched (a merge conflict) takes `from.head`'s
    /// copy, so the diff never shows conflict markers; the caller lists those paths.
    static func replayedTree(from: CompareEnd, toBase: String, git: (_ args: [String], _ environment: [String: String]?, _ allowFailure: Bool) throws -> (status: Int32, stdout: String)) throws -> (tree: String, conflicted: [String]) {
        guard let fromBase = from.base, fromBase != toBase else { return (from.head, []) }
        let merged = try git(["merge-tree", "--write-tree", "-z", "--name-only", "--merge-base", fromBase, toBase, from.head], nil, true)
        guard merged.status == 0 || merged.status == 1 else {
            throw ReviewError.git("git merge-tree exited \(merged.status)")
        }
        // -z --name-only: the tree id, NUL, then each conflicted path, NUL, then an empty field and messages.
        let fields = merged.stdout.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
        guard let tree = fields.first?.trimmingCharacters(in: .whitespacesAndNewlines), GitWorkingTreeSourceIDs.isTree(tree) else {
            throw ReviewError.git("git merge-tree gave no tree")
        }
        guard merged.status == 1 else { return (tree, []) }
        var conflicted: [String] = []
        for field in fields.dropFirst() {
            if field.isEmpty { break }
            if !conflicted.contains(field) { conflicted.append(field) }
        }
        guard !conflicted.isEmpty else { return (tree, []) }
        // A scratch index: the replayed tree, with each conflicted path set to the older head's copy.
        let index = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-review-compare-\(UUID().uuidString).index").path
        defer { try? FileManager.default.removeItem(atPath: index) }
        let environment = ["GIT_INDEX_FILE": index]
        _ = try git(["read-tree", tree], environment, false)
        for path in conflicted {
            let entry = try git(["ls-tree", "-z", from.head, "--", path], nil, false).stdout
            // "<mode> blob <oid>\t<path>"
            let parts = entry.split(separator: "\t", maxSplits: 1).first?.split(separator: " ") ?? []
            if parts.count == 3 {
                _ = try git(["update-index", "--add", "--cacheinfo", "\(parts[0]),\(parts[2]),\(path)"], environment, false)
            } else {
                _ = try git(["update-index", "--force-remove", "--", path], environment, false)
            }
        }
        let written = try git(["write-tree"], environment, false).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return (written, conflicted)
    }
}

enum GitWorkingTreeSourceIDs {
    static func isTree(_ id: String) -> Bool {
        (40...64).contains(id.count) && id.allSatisfy(\.isHexDigit)
    }
}

/// Replayed trees per (repo, ends): a merge-tree costs a few hundred ms, and the diff loads again on
/// every scope switch back.
final class CompareTreeCache: @unchecked Sendable {
    static let shared = CompareTreeCache()
    private let lock = NSLock()
    private var values: [String: (tree: String, conflicted: [String])] = [:]

    func value(_ key: String) -> (tree: String, conflicted: [String])? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    func store(_ key: String, _ value: (tree: String, conflicted: [String])) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }
}

extension DiffScope {
    func reloading(to newest: PRVersion) -> DiffScope? {
        switch self {
        case .range(let base, _, let label, let fallback):
            return .range(base: newest.baseSha ?? base, head: newest.headSha, label: label, fallbackBase: fallback)
        case .compare(let from, _, let label, let targetRef):
            return .compare(from: from, to: CompareEnd(base: newest.baseSha, head: newest.headSha), label: label, targetRef: targetRef)
        case .commit:
            return .commit(sha: newest.headSha, title: newest.commits.first?.title ?? "Newest PR commit")
        default:
            return nil
        }
    }
}
