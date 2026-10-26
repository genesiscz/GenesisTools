//
//  GitWorktreeRenames.swift
//  GenesisKit
//
//  Moves git does not report: a folder moved in Finder or by an agent, without `git mv`. Git pairs a rename only
//  when both sides are in the index, so the old paths read as deleted and the new ones as untracked (Martin,
//  2026-10-25: 147 files of a moved data folder listed as "D", each opening as "not in a git repository"). A
//  deleted file whose exact content is now an untracked file is that move. The rule is shared with the CLI
//  (`src/utils/git/worktree-renames.ts`), and `GenesisKitFixtures/Git/contract-worktree-renames.json` holds the cases both
//  sides pass.
//
//  Cost on the vault (650 deleted, 4,834 untracked): one `cat-file --batch-check` for the deleted blobs' sizes,
//  a `stat` per untracked file, and `hash-object` only for files whose size equals a deleted blob's: 46 ms, where
//  git's own detection through a scratch index (`add -N`, then `status`) took 3.9 s.
//

import Foundation

public enum GitWorktreeRenames {
    public struct Side: Equatable, Sendable {
        public var path: String
        public var oid: String

        public init(path: String, oid: String) {
            self.path = path
            self.oid = oid
        }
    }

    public struct Pair: Equatable, Sendable {
        public var old: String
        public var new: String

        public init(old: String, new: String) {
            self.old = old
            self.new = new
        }
    }

    /// The empty blob in SHA-1 and SHA-256 repositories: every empty file shares it, so it proves no move.
    static let emptyBlobs: Set<String> = [
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
        "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
    ]

    /// Pairs each deleted file with an untracked file of the same blob. Among several, the one whose path is most
    /// alike wins: the same file name first, then the most equal trailing folders, then the most equal leading ones,
    /// then byte order. Deleted files are taken in byte order; each untracked file pairs at most once.
    public static func pair(deleted: [Side], untracked: [Side]) -> [Pair] {
        var byOid: [String: [String]] = [:]
        for side in untracked where !emptyBlobs.contains(side.oid) {
            byOid[side.oid, default: []].append(side.path)
        }
        var taken = Set<String>()
        var pairs: [Pair] = []
        for side in deleted.sorted(by: { Array($0.path.utf8).lexicographicallyPrecedes(Array($1.path.utf8)) })
        where !emptyBlobs.contains(side.oid) {
            guard let candidates = byOid[side.oid] else { continue }
            let old = side.path.split(separator: "/", omittingEmptySubsequences: false)
            var best: (path: String, score: [Int])?
            for path in candidates where !taken.contains(path) {
                let new = path.split(separator: "/", omittingEmptySubsequences: false)
                let score = [old.last == new.last ? 1 : 0, commonCount(old.reversed(), new.reversed()), commonCount(old, new)]
                if let current = best {
                    if score.lexicographicallyPrecedes(current.score) { continue }
                    if score == current.score, !Array(path.utf8).lexicographicallyPrecedes(Array(current.path.utf8)) { continue }
                }
                best = (path, score)
            }
            if let best {
                taken.insert(best.path)
                pairs.append(Pair(old: side.path, new: best.path))
            }
        }
        return pairs
    }

    /// `entries` with each pair's deleted entry turned into a rename at its new path, and that untracked path dropped.
    public static func apply(_ pairs: [Pair], to entries: [GitStatusEntry]) -> [GitStatusEntry] {
        guard !pairs.isEmpty else { return entries }
        // A staged change still lives at its index path. Keep both status entries until consumers can address
        // the index and working tree separately, including a staged rename's existing oldPath.
        let eligible = Set(entries.filter { $0.staged == nil && $0.unstaged == .deleted }.map(\.path))
        let accepted = pairs.filter { eligible.contains($0.old) }
        let newByOld = Dictionary(accepted.map { ($0.old, $0.new) }, uniquingKeysWith: { first, _ in first })
        let news = Set(accepted.map(\.new))
        return entries.compactMap { entry in
            if entry.unstaged == .untracked, news.contains(entry.path) { return nil }
            guard entry.unstaged == .deleted, let new = newByOld[entry.path] else { return entry }
            var moved = entry
            moved.oldPath = entry.path
            moved.path = new
            moved.unstaged = .renamed
            return moved
        }
    }

    /// A repository status with its working-tree moves paired: the deleted side is the index's version.
    static func paired(_ entries: [GitStatusEntry], in root: URL, provider: GenesisKitGTProvider) -> [GitStatusEntry] {
        let pairs = find(in: root,
                         deleted: entries.filter { $0.staged == nil && $0.unstaged == .deleted }.map(\.path),
                         untracked: entries.filter { $0.unstaged == .untracked }.map(\.path),
                         revision: "", provider: provider)
        return apply(pairs, to: entries)
    }

    private static func commonCount<A: Sequence, B: Sequence>(_ a: A, _ b: B) -> Int where A.Element == Substring, B.Element == Substring {
        var count = 0
        for (x, y) in zip(a, b) {
            guard x == y else { break }
            count += 1
        }
        return count
    }

    /// The moves among `deleted` (repo-relative paths whose last version is at `revision`: "HEAD", "" for the index,
    /// or a commit) and `untracked` (repo-relative paths on disk). Reads only what can match: blob sizes in one
    /// `cat-file`, a `stat` per untracked file, and `hash-object` for the files of a matching size.
    public static func find(in root: URL, deleted: [String], untracked: [String], revision: String,
                            provider: GenesisKitGTProvider) -> [Pair] {
        guard !deleted.isEmpty, !untracked.isEmpty else { return [] }
        let span = PerfSpans.begin("git.worktreeRenames", "\(deleted.count) deleted \(untracked.count) untracked")
        defer { span.end() }
        // A path with a newline cannot travel through the line-based batch commands; it stays as git reports it.
        let asked = deleted.filter { !$0.contains("\n") }
        let input = Data(asked.map { "\(revision):\($0)\n" }.joined().utf8)
        guard let checked = try? provider.git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
                                              in: root, input: input, gitDirectory: nil, environment: nil),
              checked.status == 0 else { return [] }
        var deletedSides: [Side] = []
        var sizes = Set<Int>()
        for (path, line) in zip(asked, String(decoding: checked.stdout, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)) {
            let parts = line.split(separator: " ")
            guard parts.count == 3, parts[1] == "blob", let size = Int(parts[2]), size > 0 else { continue }
            deletedSides.append(Side(path: path, oid: String(parts[0])))
            sizes.insert(size)
        }
        guard !deletedSides.isEmpty else { return [] }
        var known: [Side] = []
        var unknown: [(path: String, identity: HashCache.Identity)] = []
        var info = stat()
        let base = root.path + "/"
        for path in untracked where !path.contains("\n") {
            guard lstat(base + path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, sizes.contains(Int(info.st_size)) else { continue }
            let identity = HashCache.Identity(inode: UInt64(info.st_ino), size: Int64(info.st_size),
                                              mtime: Int64(info.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(info.st_mtimespec.tv_nsec),
                                              ctime: Int64(info.st_ctimespec.tv_sec) * 1_000_000_000 + Int64(info.st_ctimespec.tv_nsec))
            if let oid = hashes.oid(base + path, identity) {
                known.append(Side(path: path, oid: oid))
            } else {
                unknown.append((path, identity))
            }
        }
        // A leading quote makes git parse a line as a C-quoted path; ./ keeps the input literal.
        if !unknown.isEmpty {
            guard let hashed = try? provider.git(["hash-object", "--stdin-paths"], in: root,
                                                 input: Data(unknown.map { "./" + $0.path + "\n" }.joined().utf8), gitDirectory: nil, environment: nil),
                  hashed.status == 0 else { return [] }
            let oids = String(decoding: hashed.stdout, as: UTF8.self).split(separator: "\n").map(String.init)
            guard oids.count == unknown.count else { return [] }
            for (file, oid) in zip(unknown, oids) {
                hashes.store(base + file.path, file.identity, oid)
                known.append(Side(path: file.path, oid: oid))
            }
        }
        return pair(deleted: deletedSides, untracked: known)
    }

    /// Blob ids of untracked files by file identity (inode, size, mtime and ctime to the nanosecond): a file that did
    /// not change is not hashed again on the next status read. The ctime catches a rewrite that kept the size and put
    /// the mtime back (performance skill, caching-and-freshness.md: the mtime alone is not enough). Shared by every repository, bounded.
    static let hashes = HashCache(limit: 50_000)

    final class HashCache: @unchecked Sendable {
        struct Identity: Equatable {
            let inode: UInt64
            let size: Int64
            let mtime: Int64
            let ctime: Int64
        }
        private let lock = NSLock()
        private var entries: [String: (identity: Identity, oid: String)] = [:]
        private let limit: Int

        init(limit: Int) {
            self.limit = limit
        }

        func oid(_ path: String, _ identity: Identity) -> String? {
            lock.lock()
            defer { lock.unlock() }
            guard let entry = entries[path], entry.identity == identity else { return nil }
            return entry.oid
        }

        func store(_ path: String, _ identity: Identity, _ oid: String) {
            lock.lock()
            defer { lock.unlock() }
            // Past the bound the cache starts over: simpler than an order list, and a refill costs one hash pass.
            if entries.count >= limit, entries[path] == nil { entries.removeAll(keepingCapacity: true) }
            entries[path] = (identity, oid)
        }
    }
}
