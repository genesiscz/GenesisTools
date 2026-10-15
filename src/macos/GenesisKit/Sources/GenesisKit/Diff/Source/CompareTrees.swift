//
//  CompareTrees.swift
//  GenesisKit
//
//  A compare diff of two pushes: the older change replayed onto the newer base (`git merge-tree`), cached per repo
//  and ends.
//

import Foundation

extension GitWorkingTreeSource {
    /// The tree of `from`'s change replayed onto `toBase`: `from.head` itself when both start from the
    /// same base. A path both the change and the upstream touched (a merge conflict) takes `from.head`'s
    /// copy, so the diff never shows conflict markers; the caller lists those paths.
    public static func replayedTree(from: CompareEnd, toBase: String, git: (_ args: [String], _ environment: [String: String]?, _ allowFailure: Bool) throws -> (status: Int32, stdout: String)) throws -> (tree: String, conflicted: [String]) {
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

public enum GitWorkingTreeSourceIDs {
    public static func isTree(_ id: String) -> Bool {
        (40...64).contains(id.count) && id.allSatisfy(\.isHexDigit)
    }
}

/// Replayed trees per (repo, ends): a merge-tree costs a few hundred ms, and the diff loads again on
/// every scope switch back.
public final class CompareTreeCache: @unchecked Sendable {
    public static let shared = CompareTreeCache()
    private let lock = NSLock()
    private var values: [String: (tree: String, conflicted: [String])] = [:]

    public func value(_ key: String) -> (tree: String, conflicted: [String])? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func store(_ key: String, _ value: (tree: String, conflicted: [String])) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }
}

/// One end of a compare diff: a head and the merge base its change starts from (nil: the window
/// takes the merge base with the target branch, as GitHub names none).
public struct CompareEnd: Hashable, Codable {
    public var base: String?
    public var head: String

    public init(base: String? = nil, head: String) {
        self.base = base
        self.head = head
    }
}
