//
//  VaultIndex.swift
//  GenesisKit
//
//  The notes vault's search index: an SQLite FTS5 sidecar that the Genesis vault pane maintains. The markdown
//  viewer reads it read-only for its `[[` / `#` completions and the property vocabulary, in any host.
//

import CryptoKit
import Foundation
import SQLite3

/// Sidecar SQLite FTS5 index for a vault (Spec 06 M1#4).
///
/// Lives OUTSIDE the vault at `~/.genesis/knowledge/<sha256(vaultRoot)>/index.sqlite`
/// so Tresorit/Obsidian sync never sees it. Full note bodies are indexed (no 40k cap);
/// a `links` table persists the wikilink edge list so graph rebuilds never re-read
/// every body from disk.
///
/// Thread-safety: all access is funneled through an internal serial queue; the
/// public API is synchronous-but-cheap (queries) or fire-and-forget (upserts).
public final class VaultIndex {
    public struct SearchRow {
        public var path: String
        public var title: String
        public var mtimeMs: Double
        public var bm25: Double
        public var snippet: String?
        public var matchedTitle: Bool
        public var matchedHeadings: Bool
        public var matchedProps: Bool
    }

    public struct NoteMeta {
        public var path: String
        public var title: String
        public var mtimeMs: Double
    }

    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "dev.genesis.vault-index")
    public let dbPath: String

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    // MARK: - Lifecycle

    /// `readOnly` is for a reader of an index someone else maintains (the markdown viewer's completions): it never
    /// creates the folder, the file or the tables, and throws when there is no index yet.
    public init(vaultRoot: String, directory: URL? = nil, readOnly: Bool = false) throws {
        let dir = directory ?? Self.sidecarDirectory(vaultRoot: vaultRoot)
        if !readOnly {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        dbPath = dir.appendingPathComponent("index.sqlite").path
        let flags = readOnly
            ? SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX
            : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        var handle: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &handle, flags, nil) == SQLITE_OK else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(handle)
            throw IndexError.sqlite(msg)
        }
        db = handle
        if !readOnly {
            try queue.sync { try migrate() }
        }
    }

    deinit {
        sqlite3_close(db)
    }

    public static func sidecarDirectory(vaultRoot: String) -> URL {
        let digest = SHA256.hash(data: Data(vaultRoot.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined().prefix(16)
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".genesis/knowledge/\(hex)")
    }

    private func migrate() throws {
        try exec("""
        CREATE TABLE IF NOT EXISTS notes(
            path TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            mtime_ms REAL NOT NULL,
            tags TEXT NOT NULL DEFAULT '',
            props TEXT NOT NULL DEFAULT ''
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            path UNINDEXED, title, headings, body, props,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS links(
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            PRIMARY KEY (src, dst)
        );
        CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
        """)
    }

    // MARK: - Writes

    public func upsert(
        path: String,
        title: String,
        body: String,
        mtimeMs: Double,
        headings: [String],
        tags: [String],
        props: String,
        resolvedLinkPaths: [String]
    ) {
        queue.sync {
            _ = try? exec("BEGIN")
            run("DELETE FROM notes WHERE path = ?1", [path])
            run("DELETE FROM notes_fts WHERE path = ?1", [path])
            run("DELETE FROM links WHERE src = ?1", [path])
            run(
                "INSERT INTO notes(path, title, mtime_ms, tags, props) VALUES (?1, ?2, ?3, ?4, ?5)",
                [path, title, mtimeMs, tags.joined(separator: " "), props]
            )
            run(
                "INSERT INTO notes_fts(path, title, headings, body, props) VALUES (?1, ?2, ?3, ?4, ?5)",
                [path, title, headings.joined(separator: "\n"), body, props]
            )
            for dst in Set(resolvedLinkPaths) {
                run("INSERT OR IGNORE INTO links(src, dst) VALUES (?1, ?2)", [path, dst])
            }
            _ = try? exec("COMMIT")
        }
    }

    public func remove(path: String) {
        queue.sync {
            run("DELETE FROM notes WHERE path = ?1", [path])
            run("DELETE FROM notes_fts WHERE path = ?1", [path])
            run("DELETE FROM links WHERE src = ?1 OR dst = ?1", [path])
        }
    }

    public func removeAll() {
        queue.sync {
            _ = try? exec("DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM links;")
        }
    }

    // MARK: - Reads

    /// mtimes for incremental re-index decisions (path → mtimeMs).
    public func indexedMtimes() -> [String: Double] {
        queue.sync {
            var out: [String: Double] = [:]
            query("SELECT path, mtime_ms FROM notes") { stmt in
                let path = String(cString: sqlite3_column_text(stmt, 0))
                out[path] = sqlite3_column_double(stmt, 1)
            }
            return out
        }
    }

    public func noteCount() -> Int {
        queue.sync {
            var n = 0
            query("SELECT COUNT(*) FROM notes") { stmt in
                n = Int(sqlite3_column_int64(stmt, 0))
            }
            return n
        }
    }

    /// All persisted wikilink edges (src → dst, resolved relative paths).
    public func allLinks() -> [(from: String, to: String)] {
        queue.sync {
            var out: [(String, String)] = []
            query("SELECT src, dst FROM links") { stmt in
                out.append((
                    String(cString: sqlite3_column_text(stmt, 0)),
                    String(cString: sqlite3_column_text(stmt, 1))
                ))
            }
            return out
        }
    }

    /// Inbound links (backlinks) for a note path.
    public func backlinks(of path: String) -> [String] {
        queue.sync {
            var out: [String] = []
            query("SELECT src FROM links WHERE dst = ?1 ORDER BY src", binds: [path]) { stmt in
                out.append(String(cString: sqlite3_column_text(stmt, 0)))
            }
            return out
        }
    }

    /// FTS query: each whitespace term becomes a quoted prefix token, AND-combined.
    /// Returns rows with bm25 rank + column-hit flags for the ranking layer.
    public func search(query raw: String, limit: Int = 60) -> [SearchRow] {
        let match = Self.ftsMatchExpression(raw)
        guard !match.isEmpty else { return [] }
        return queue.sync {
            var out: [SearchRow] = []
            // Column-hit flags are recomputed per row in Swift (cheaper than
            // three extra MATCH subqueries); headings/props text is fetched.
            let simpleSQL = """
            SELECT f.path, n.title, n.mtime_ms,
                   bm25(notes_fts, 8.0, 4.0, 1.0, 2.0) AS rank,
                   snippet(notes_fts, 3, '', '', '…', 12) AS snip,
                   f.headings, f.props
            FROM notes_fts f
            JOIN notes n ON n.path = f.path
            WHERE notes_fts MATCH ?1
            ORDER BY rank
            LIMIT ?2
            """
            let terms = Self.terms(raw)
            query(simpleSQL, binds: [match, limit]) { stmt in
                let path = String(cString: sqlite3_column_text(stmt, 0))
                let title = String(cString: sqlite3_column_text(stmt, 1))
                let mtime = sqlite3_column_double(stmt, 2)
                let rank = sqlite3_column_double(stmt, 3)
                let snip = sqlite3_column_text(stmt, 4).map { String(cString: $0) }
                let headings = sqlite3_column_text(stmt, 5).map { String(cString: $0) } ?? ""
                let props = sqlite3_column_text(stmt, 6).map { String(cString: $0) } ?? ""
                let titleLower = title.lowercased()
                let headingsLower = headings.lowercased()
                let propsLower = props.lowercased()
                out.append(SearchRow(
                    path: path,
                    title: title,
                    mtimeMs: mtime,
                    bm25: rank,
                    snippet: snip?.isEmpty == true ? nil : snip,
                    matchedTitle: terms.allSatisfy { titleLower.contains($0) },
                    matchedHeadings: !terms.isEmpty && terms.contains(where: { headingsLower.contains($0) }),
                    matchedProps: !terms.isEmpty && terms.contains(where: { propsLower.contains($0) })
                ))
            }
            return out
        }
    }

    /// Recent notes by mtime (empty-query palette).
    public func recent(limit: Int = 30) -> [NoteMeta] {
        queue.sync {
            var out: [NoteMeta] = []
            query("SELECT path, title, mtime_ms FROM notes ORDER BY mtime_ms DESC LIMIT ?1", binds: [limit]) { stmt in
                out.append(NoteMeta(
                    path: String(cString: sqlite3_column_text(stmt, 0)),
                    title: String(cString: sqlite3_column_text(stmt, 1)),
                    mtimeMs: sqlite3_column_double(stmt, 2)
                ))
            }
            return out
        }
    }

    /// Note names for the `[[wikilink]]` picker: the file's own name without
    /// `.md`, the way a wikilink spells it. Names that start with the prefix
    /// come first, then the shortest.
    public func noteNames(matching prefix: String, limit: Int = 20) -> [String] {
        let needle = prefix.lowercased()
        return queue.sync {
            var names: [String] = []
            let sql = needle.isEmpty
                ? "SELECT path FROM notes ORDER BY mtime_ms DESC LIMIT 400"
                : "SELECT path FROM notes WHERE lower(path) LIKE ?1 ORDER BY mtime_ms DESC LIMIT 400"
            query(sql, binds: needle.isEmpty ? [] : ["%\(needle)%"]) { stmt in
                let path = String(cString: sqlite3_column_text(stmt, 0))
                var name = (path as NSString).lastPathComponent
                if name.hasSuffix(".md") { name = String(name.dropLast(3)) }
                names.append(name)
            }
            var seen = Set<String>()
            let unique = names.filter { seen.insert($0.lowercased()).inserted }
            let matching = needle.isEmpty ? unique : unique.filter { $0.lowercased().contains(needle) }
            return Array(matching.sorted { a, b in
                let aStarts = a.lowercased().hasPrefix(needle)
                let bStarts = b.lowercased().hasPrefix(needle)
                if aStarts != bStarts { return aStarts }
                if a.count != b.count { return a.count < b.count }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }.prefix(limit))
        }
    }

    /// Every tag the vault already uses, for the `#tag` picker.
    public func tags(matching prefix: String, limit: Int = 20) -> [String] {
        let needle = prefix.lowercased()
        return queue.sync {
            var all: [String] = []
            query("SELECT tags FROM notes WHERE tags <> ''") { stmt in
                all.append(contentsOf: String(cString: sqlite3_column_text(stmt, 0)).split(separator: " ").map(String.init))
            }
            var counts: [String: Int] = [:]
            for tag in all where needle.isEmpty || tag.lowercased().contains(needle) {
                counts[tag, default: 0] += 1
            }
            return Array(counts.keys.sorted { a, b in
                let aStarts = a.lowercased().hasPrefix(needle)
                let bStarts = b.lowercased().hasPrefix(needle)
                if aStarts != bStarts { return aStarts }
                let ca = counts[a] ?? 0
                let cb = counts[b] ?? 0
                if ca != cb { return ca > cb }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }.prefix(limit))
        }
    }

    /// The frontmatter vocabulary of the vault: which property keys exist and
    /// which values each one is given, most used first. Props are indexed as
    /// space-joined `key:value` pairs (see `VaultStore.extractIndexDoc`).
    public func propertyVocabulary(keyLimit: Int = 60, valueLimit: Int = 30) -> [String: [String]] {
        queue.sync {
            var keyCount: [String: Int] = [:]
            var valueCount: [String: [String: Int]] = [:]
            query("SELECT props FROM notes WHERE props <> ''") { stmt in
                for pair in String(cString: sqlite3_column_text(stmt, 0)).split(separator: " ") {
                    guard let colon = pair.firstIndex(of: ":") else { continue }
                    let key = String(pair[..<colon])
                    let value = String(pair[pair.index(after: colon)...])
                    guard !key.isEmpty else { continue }
                    keyCount[key, default: 0] += 1
                    if !value.isEmpty, value.count < 60 {
                        valueCount[key, default: [:]][value, default: 0] += 1
                    }
                }
            }
            let keys = keyCount.keys.sorted { (keyCount[$0] ?? 0, $1) > (keyCount[$1] ?? 0, $0) }.prefix(keyLimit)
            var out: [String: [String]] = [:]
            for key in keys {
                let counts = valueCount[key] ?? [:]
                out[key] = Array(counts.keys.sorted { (counts[$0] ?? 0, $1) > (counts[$1] ?? 0, $0) }.prefix(valueLimit))
            }
            return out
        }
    }

    public static func terms(_ raw: String) -> [String] {
        raw.lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
            .filter { !$0.isEmpty }
    }

    /// `"foo"* AND "bar"*` — quoted so FTS operators in user input can't inject syntax.
    public static func ftsMatchExpression(_ raw: String) -> String {
        terms(raw)
            .map { term in
                let cleaned = term.replacingOccurrences(of: "\"", with: "")
                return cleaned.isEmpty ? nil : "\"\(cleaned)\"*"
            }
            .compactMap { $0 }
            .joined(separator: " AND ")
    }

    // MARK: - SQLite plumbing

    public enum IndexError: Error {
        case sqlite(String)
    }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let msg = err.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(err)
            throw IndexError.sqlite(msg)
        }
    }

    private func run(_ sql: String, _ binds: [Any]) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, binds)
        _ = sqlite3_step(stmt)
    }

    private func query(_ sql: String, binds: [Any] = [], row: (OpaquePointer) -> Void) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, binds)
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let stmt { row(stmt) }
        }
    }

    private func bind(_ stmt: OpaquePointer?, _ binds: [Any]) {
        for (i, v) in binds.enumerated() {
            let idx = Int32(i + 1)
            switch v {
            case let s as String: sqlite3_bind_text(stmt, idx, s, -1, Self.transient)
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            default: sqlite3_bind_null(stmt, idx)
            }
        }
    }
}
