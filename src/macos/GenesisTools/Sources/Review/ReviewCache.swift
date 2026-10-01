import CryptoKit
import Foundation

/// The review window's last answers, in GenesisKit's `DiskCache` under `~/.genesis-tools/review/cache/`.
/// Each view paints the cached answer at once, marks it as refreshing and always loads again behind it.
/// Every read here decodes JSON, so it runs off the main thread.
enum ReviewCache {
    static let threads = DiskCache(folder: "review", namespace: "threads")
    static let diffs = DiskCache(folder: "review", namespace: "diff")
    static let blame = DiskCache(folder: "review", namespace: "blame")
    static let sessions = DiskCache(folder: "review", namespace: "session")
    /// Diff snapshots are written here in load order, so an older load never overwrites a newer one.
    static let writer = DispatchQueue(label: "review.cache.writer", qos: .utility)

    /// A diff whose JSON is larger keeps its file list and counts only: decoding many MB before the first
    /// paint costs more than it saves, and the fresh load brings the contents a moment later.
    static let maxDiffBytes = 5_000_000
    /// What a file stripped of its contents shows until the fresh load replaces it.
    static let strippedNote = "Loading this file's diff…"

    // MARK: PR threads

    /// The raw `tools hub pr threads --json` answer, per PR (its URL or `--repo` path).
    static func threadsKey(_ target: PRTarget) -> String {
        target.argv.joined(separator: " ")
    }

    // MARK: Diff snapshots

    struct Diff: Codable, Equatable {
        /// The exact scope it answers (`scopeKey`); a slot holds one at a time.
        let scope: String
        let branch: String
        let base: String?
        let files: [DiffFile]
        /// The contents were dropped for size (`maxDiffBytes`).
        let stripped: Bool
    }

    /// The exact scope a snapshot answers. A turns scope belongs to its session.
    static func scopeKey(_ scope: DiffScope, session: String?) -> String {
        switch scope {
        case .lastTurns(let count): return "lastTurns:\(count):\(session ?? "-")"
        case .uncommitted: return "uncommitted"
        case .unstaged: return "unstaged"
        case .staged: return "staged"
        case .branch: return "branch"
        case .commit(let sha, _): return "commit:\(sha)"
        case .range(let base, let head, _, _): return "range:\(base)-\(head)"
        }
    }

    /// The file a snapshot lives in: one per repository and scope, where a commit shares one slot and a
    /// range has one per label (per PR), so the files of old shas do not pile up.
    static func diffSlot(repo: String, scope: DiffScope, session: String?) -> String {
        switch scope {
        case .commit: return "\(repo)|commit"
        case .range(_, _, let label, _): return "\(repo)|range:\(label)"
        default: return "\(repo)|\(scopeKey(scope, session: session))"
        }
    }

    static func readDiff(repo: String, scope: DiffScope, session: String?) -> Diff? {
        guard let diff = diffs.read(Diff.self, key: diffSlot(repo: repo, scope: scope, session: session)),
              diff.scope == scopeKey(scope, session: session) else { return nil }
        return diff
    }

    /// Encodes `snapshot` for its slot; the contents go when the whole would pass `maxDiffBytes`.
    static func encodeDiff(_ snapshot: GitWorkingTreeSource.Snapshot, scope: DiffScope, session: String?) -> Data? {
        let key = scopeKey(scope, session: session)
        let full = Diff(scope: key, branch: snapshot.branch, base: snapshot.base, files: snapshot.files, stripped: false)
        guard let data = try? JSONEncoder().encode(full) else { return nil }
        guard data.count > maxDiffBytes else { return data }
        let files = snapshot.files.map { file -> DiffFile in
            var copy = file
            copy.oldContents = nil
            copy.newContents = nil
            copy.skipped = copy.skipped ?? strippedNote
            return copy
        }
        return try? JSONEncoder().encode(Diff(scope: key, branch: snapshot.branch, base: snapshot.base, files: files, stripped: true))
    }

    static func writeDiff(_ snapshot: GitWorkingTreeSource.Snapshot, repo: String, scope: DiffScope, session: String?) {
        guard let data = encodeDiff(snapshot, scope: scope, session: session) else { return }
        diffs.writeData(data, key: diffSlot(repo: repo, scope: scope, session: session))
    }

    // MARK: Agent blame

    /// One file's blame, valid only while the file's text still hashes to `sha`.
    struct Blame: Codable, Equatable {
        let sha: String
        let sources: [AgentBlameSource]
        /// `[startLine, endLine, index into sources]`.
        let ranges: [[Int]]
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The hash of a file's text on disk now: what `tools agents blame` numbers its lines on.
    static func contentHash(repo: String, path: String) -> String? {
        (try? Data(contentsOf: URL(fileURLWithPath: repo).appendingPathComponent(path))).map(sha256)
    }

    /// The cached blame of `paths` whose text on disk still has the cached hash, as one result, and the
    /// paths left to ask `tools` (with the hash each had now).
    static func readBlame(repo: String, paths: [String], in cache: DiskCache = blame) -> (found: AgentBlameResult, missing: [String], hashes: [String: String]) {
        var sources: [AgentBlameSource] = []
        var files: [AgentBlameFile] = []
        var missing: [String] = []
        var hashes: [String: String] = [:]
        for path in paths {
            let hash = contentHash(repo: repo, path: path)
            hashes[path] = hash
            guard let hash, let entry = cache.read(Blame.self, key: "\(repo)|\(path)"), entry.sha == hash else {
                missing.append(path)
                continue
            }
            let offset = sources.count
            sources += entry.sources
            files.append(AgentBlameFile(path: path, ranges: entry.ranges.filter { $0.count == 3 }.map { [$0[0], $0[1], $0[2] + offset] }))
        }
        return (AgentBlameResult(sources: sources, files: files, elapsedMs: nil), missing, hashes)
    }

    /// Stores each asked path's blame under the hash its text had before the call (a file with no agent
    /// lines stores an empty list, so its next hover is answered from here too).
    static func writeBlame(_ result: AgentBlameResult, repo: String, asked: [String], hashes: [String: String], in cache: DiskCache = blame) {
        let byPath = Dictionary(result.files.map { ($0.path, $0.ranges) }, uniquingKeysWith: { first, _ in first })
        for path in asked {
            guard let hash = hashes[path], hash == contentHash(repo: repo, path: path) else { continue }
            let ranges = (byPath[path] ?? []).filter { $0.count == 3 && result.sources.indices.contains($0[2]) }
            let used = Array(Set(ranges.map { $0[2] })).sorted()
            let remap = Dictionary(uniqueKeysWithValues: used.enumerated().map { ($1, $0) })
            let entry = Blame(sha: hash, sources: used.map { result.sources[$0] },
                              ranges: ranges.map { [$0[0], $0[1], remap[$0[2]] ?? 0] })
            cache.write(entry, key: "\(repo)|\(path)")
        }
    }

    /// Two answers as one: `second`'s ranges point past `first`'s sources.
    static func combine(_ first: AgentBlameResult, _ second: AgentBlameResult) -> AgentBlameResult {
        let offset = first.sources.count
        let moved = second.files.map { file in
            AgentBlameFile(path: file.path, ranges: file.ranges.map { $0.count == 3 ? [$0[0], $0[1], $0[2] + offset] : $0 })
        }
        return AgentBlameResult(sources: first.sources + second.sources, files: first.files + moved, elapsedMs: second.elapsedMs)
    }
}
