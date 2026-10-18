import Foundation
import GenesisKit

/// Where an agent session has been working, among the checkouts of one repository: how many of the files its
/// recent turns changed lie in each. A session often starts in the main checkout and works in a linked
/// worktree, and the Changes and Files tabs kept showing the main checkout, which held none of its work
/// (2026-10-16).
enum WorktreeActivity {
    /// `/private/tmp/x` and `/tmp/x` name one folder; git lists the first, a tool call records the second.
    private static func normalized(_ path: String) -> String {
        var clean = URL(fileURLWithPath: path).standardizedFileURL.path
        for system in ["/private/tmp", "/private/var"] where clean == system || clean.hasPrefix(system + "/") {
            clean = String(clean.dropFirst("/private".count))
        }
        return clean
    }

    /// The checkout a file lies in: the one with the longest path that contains it, so a linked worktree nested
    /// in the main checkout counts for itself. nil when the file lies in none.
    private static func checkout(of file: String, in trees: [(path: String, root: String)]) -> String? {
        let clean = normalized(file)
        return trees
            .filter { clean == $0.root || clean.hasPrefix($0.root + "/") }
            .max { $0.root.count < $1.root.count }?.path
    }

    /// Files per checkout path; a checkout the session did not touch is absent.
    static func counts(files: [String], worktrees: [RepoWorktree]) -> [String: Int] {
        let trees = worktrees.map { (path: $0.path, root: normalized($0.path)) }
        var counts: [String: Int] = [:]
        for file in files {
            if let tree = checkout(of: file, in: trees) { counts[tree, default: 0] += 1 }
        }
        return counts
    }

    /// The checkout with the most changed files; ties keep git's worktree order. The provider merges files by
    /// path, so their array order carries no recency. nil when none lies in a checkout.
    static func recommended(files: [String], worktrees: [RepoWorktree]) -> String? {
        let counts = counts(files: files, worktrees: worktrees)
        guard let most = counts.values.max() else { return nil }
        return worktrees.first { counts[$0.path] == most }?.path
    }

    /// The Worktree menu's order: the checkouts the session changed files in first (most files first), the rest as
    /// `git worktree list` gave them.
    static func ordered(_ worktrees: [RepoWorktree], counts: [String: Int]) -> [RepoWorktree] {
        worktrees.enumerated()
            .sorted { lhs, rhs in
                let (left, right) = (counts[lhs.element.path] ?? 0, counts[rhs.element.path] ?? 0)
                return left != right ? left > right : lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// The menu title of one checkout: its own title, how many files this session changed there, and a star on the
    /// recommended one when the session changed files in more than one.
    static func title(of tree: RepoWorktree, files: Int, recommended: Bool) -> String {
        var title = tree.title
        if files > 0 { title += "  ·  \(files) \(files == 1 ? "file" : "files") by this session" }
        return recommended ? "★ " + title : title
    }

    private struct CacheKey: Hashable {
        let session: String
        let roots: [String]
    }

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: [CacheKey: (at: Date, files: [String])] = [:]
    private static let cacheSeconds: TimeInterval = 120

    /// The files the session's recent turns changed. The last 5 turns first: where it works now is
    /// what matters. When none of those lies in a checkout of this repository, the last 50.
    static func changedFiles(session: String, worktrees: [RepoWorktree]) -> [String] {
        let key = CacheKey(session: session, roots: Array(Set(worktrees.map { normalized($0.path) })).sorted())
        cacheLock.lock()
        let cached = cache[key]
        cacheLock.unlock()
        if let cached, Date().timeIntervalSince(cached.at) < cacheSeconds { return cached.files }

        var found: [String] = []
        for turns in [5, 50] {
            do {
                found = try GenesisKitGT.provider.agentTurnChanges(session: session, lastTurns: turns).files.map(\.path)
            } catch {
                HubPerf.log("review.worktree activity \(session.prefix(8)) failed: \(error)")
                return []
            }
            if !counts(files: found, worktrees: worktrees).isEmpty { break }
        }
        cacheLock.lock()
        cache[key] = (Date(), found)
        cacheLock.unlock()
        return found
    }
}

extension ReviewModel {
    /// Reads where the session worked. The window opens on the checkout it worked in most, unless somebody picked
    /// one: a repository with a single checkout, or a window without a session, never asks.
    func refreshWorktreeActivity(load: @escaping @Sendable (String, [RepoWorktree]) -> [String] = { WorktreeActivity.changedFiles(session: $0, worktrees: $1) }) {
        guard let session, worktrees.count > 1, !activityRequested else { return }
        activityRequested = true
        let trees = worktrees
        Task.detached(priority: .utility) { [weak self] in
            let files = load(session, trees)
            let counts = WorktreeActivity.counts(files: files, worktrees: trees)
            let best = WorktreeActivity.recommended(files: files, worktrees: trees)
            await MainActor.run {
                guard let self else { return }
                self.activityRequested = false
                self.worktreeActivity = counts
                self.recommendedWorktree = best
                if !self.worktreeChosen, let best, best != self.repo.path {
                    HubPerf.log("review.worktree auto \(self.repo.path) -> \(best) (\(counts[best] ?? 0) files)")
                    self.switchWorktree(to: best, chosen: false)
                }
            }
        }
    }
}
