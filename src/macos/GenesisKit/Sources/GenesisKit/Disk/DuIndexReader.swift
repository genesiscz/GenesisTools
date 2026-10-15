import Foundation
import SQLite3

/// Where a path sits in the index.
public enum DuIndexLookup: Equatable, Sendable {
    /// A stored folder.
    case found(DuIndexNode)
    /// Below a stored folder whose small subfolders were folded into it (or a folder gone since the last scan):
    /// `into` holds the total; `tools du clonesize <path> --depth 1` measures the path itself.
    case folded(path: String, into: DuIndexNode)
    /// Outside every indexed root.
    case notIndexed
}

/// The order of `DuIndexReader.children`.
public enum DuIndexChildSort: String, CaseIterable, Sendable {
    case alloc
    case logical
    case `private`
    case files
    case mtime
    case name

    var orderBy: String {
        switch self {
        case .alloc: return "alloc_bytes DESC, name"
        case .logical: return "logical_bytes DESC, name"
        case .private: return "private_bytes DESC, name"
        case .files: return "files DESC, name"
        case .mtime: return "newest_mtime_s DESC, name"
        case .name: return "name COLLATE NOCASE"
        }
    }
}

/// Reads `~/.genesis-tools/du/index.db` (written by `tools du index`) for the Explorer: a folder, its children,
/// the big files under it, the scans. Read-only by construction: the connection runs with `PRAGMA query_only`,
/// never runs DDL, `journal_mode` or a checkpoint, and each call is one short read transaction, so a running build
/// (WAL) never waits for the UI and the UI sees the last committed snapshot. It opens `SQLITE_OPEN_READONLY`;
/// when the WAL files are missing (the CLI deletes them on a clean close, so after every build) such a connection
/// cannot create them and every read fails with SQLITE_CANTOPEN, so it then opens `SQLITE_OPEN_READWRITE` (never
/// CREATE), still under `query_only`. Measured 2026-10-14: the app showed "no index" after each finished build.
///
/// Calls block on SQLite (with `busyTimeout` for the moment a checkpoint holds the file): call them off the main
/// thread. A newer schema than `supportedSchemaVersion` is refused at `init`.
public final class DuIndexReader: @unchecked Sendable {
    public enum ReaderError: Error, LocalizedError, Equatable {
        /// No index file yet: offer `tools du index build`.
        case missing(String)
        case open(String)
        case schemaNewer(found: Int, supported: Int)
        /// A statement failed; `busy` is true when the database was locked past the busy timeout.
        case query(String, busy: Bool)

        public var errorDescription: String? {
            switch self {
            case .missing(let path): return "No disk index at \(path) yet."
            case .open(let message): return "The disk index could not be opened: \(message)"
            case .schemaNewer(let found, let supported):
                return "The disk index has schema \(found); this app reads up to \(supported). Update the app."
            case .query(let message, _): return "The disk index could not be read: \(message)"
            }
        }
    }

    public static let supportedSchemaVersion = 1

    public static var defaultPath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools/du/index.db").path
    }

    public let path: String
    private var db: OpaquePointer?
    /// Recursive, so a public read may call another one inside its transaction.
    private let lock = NSRecursiveLock()
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private static let goneFlag: Int64 = 16
    private static let nodeColumns = """
        d.id, d.parent_id, d.name, d.alloc_bytes, d.logical_bytes, d.private_bytes, d.files, d.dirs, d.max_file_bytes,
        d.newest_mtime_s, d.dir_mtime_ms, d.flags, d.scan_id,
        (SELECT COUNT(*) FROM dirs c WHERE c.parent_id = d.id AND (c.flags & 16) = 0)
        """

    public init(path: String = DuIndexReader.defaultPath, busyTimeout: Int32 = 2_000) throws {
        self.path = path
        guard FileManager.default.fileExists(atPath: path) else { throw ReaderError.missing(path) }
        // Not `immutable=1`: that would ignore the WAL and miss the last build.
        var handle = try Self.open(path, flags: SQLITE_OPEN_READONLY, busyTimeout: busyTimeout)
        if Self.probe(handle) == SQLITE_CANTOPEN {
            sqlite3_close(handle)
            handle = try Self.open(path, flags: SQLITE_OPEN_READWRITE, busyTimeout: busyTimeout)
        }
        db = handle
        guard let found = try storedSchemaVersion() else {
            sqlite3_close(handle)
            db = nil
            throw ReaderError.open("\(path) has no schema_version in meta")
        }
        guard found <= Self.supportedSchemaVersion else {
            sqlite3_close(handle)
            db = nil
            throw ReaderError.schemaNewer(found: found, supported: Self.supportedSchemaVersion)
        }
    }

    deinit {
        sqlite3_close_v2(db)
    }

    private static func open(_ path: String, flags: Int32, busyTimeout: Int32) throws -> OpaquePointer {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, flags | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(handle)
            throw ReaderError.open(message)
        }
        sqlite3_busy_timeout(handle, busyTimeout)
        sqlite3_exec(handle, "PRAGMA query_only = 1;", nil, nil, nil)
        return handle
    }

    /// The result code of the first read (SQLite opens the WAL files lazily, so `open_v2` alone succeeds).
    private static func probe(_ handle: OpaquePointer) -> Int32 {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        let prepared = sqlite3_prepare_v2(handle, "SELECT 1 FROM sqlite_master LIMIT 1", -1, &statement, nil)
        guard prepared == SQLITE_OK else { return prepared }
        let stepped = sqlite3_step(statement)
        return stepped == SQLITE_ROW || stepped == SQLITE_DONE ? SQLITE_OK : stepped
    }

    // MARK: - Reads

    /// The `meta` table.
    public func meta() throws -> [String: String] {
        try locked {
            var result: [String: String] = [:]
            try query("SELECT key, value FROM meta") { row in
                result[row.text(0)] = row.text(1)
            }
            return result
        }
    }

    /// 0 when the row is missing (`init` refuses such a database).
    public func schemaVersion() throws -> Int {
        try storedSchemaVersion() ?? 0
    }

    private func storedSchemaVersion() throws -> Int? {
        try locked {
            var version: Int?
            try query("SELECT value FROM meta WHERE key = 'schema_version'") { row in version = Int(row.text(0)) }
            return version
        }
    }

    /// The root rows (one per indexed root); their `path` is their name.
    public func roots() throws -> [DuIndexNode] {
        try locked { try rootsLocked() }
    }

    private func rootsLocked() throws -> [DuIndexNode] {
        var result: [DuIndexNode] = []
        try query("SELECT \(Self.nodeColumns) FROM dirs d WHERE d.parent_id = 0 AND (d.flags & 16) = 0 ORDER BY d.name") { row in
            var node = row.node()
            node.path = node.name
            result.append(node)
        }
        return result
    }

    public func node(id: Int64) throws -> DuIndexNode? {
        try transaction {
            var found: DuIndexNode?
            try query("SELECT \(Self.nodeColumns) FROM dirs d WHERE d.id = ?1", [.int(id)]) { found = $0.node() }
            guard var node = found else { return nil }
            node.path = try pathLocked(of: node.id)
            return node
        }
    }

    /// The stored folder at `path`, the stored folder it is folded into, or `notIndexed`.
    public func lookup(_ path: String) throws -> DuIndexLookup {
        let target = Self.normalize(path)
        return try transaction {
            var roots: [DuIndexNode] = []
            try query("SELECT \(Self.nodeColumns) FROM dirs d WHERE d.parent_id = 0 AND (d.flags & 16) = 0") { row in
                var node = row.node()
                node.path = node.name
                roots.append(node)
            }
            // The deepest root that contains the path.
            guard var current = roots.filter({ Self.contains($0.name, target) }).max(by: { $0.name.count < $1.name.count })
            else { return .notIndexed }
            let rest = target == current.name ? "" : String(target.dropFirst(current.name == "/" ? 1 : current.name.count + 1))
            for component in rest.split(separator: "/") where !component.isEmpty {
                var child: DuIndexNode?
                try query("SELECT \(Self.nodeColumns) FROM dirs d WHERE d.parent_id = ?1 AND d.name = ?2",
                          [.int(current.id), .text(String(component))]) { child = $0.node() }
                guard var next = child, next.flags.rawValue & Int(Self.goneFlag) == 0 else {
                    return .folded(path: target, into: current)
                }
                next.path = Self.join(current.path ?? current.name, next.name)
                current = next
            }
            return .found(current)
        }
    }

    /// The stored children of `node` that are still there, sorted, at least `minBytes` allocated.
    public func children(of node: DuIndexNode, sort: DuIndexChildSort = .alloc, limit: Int = 200,
                         minBytes: Int64 = 0) throws -> [DuIndexNode] {
        try transaction {
            let parentPath = try node.path ?? pathLocked(of: node.id)
            // The parent's size from the same read as the children: the caller's copy may predate an update.
            var parentBytes = node.allocBytes
            try query("SELECT alloc_bytes FROM dirs WHERE id = ?1", [.int(node.id)]) { parentBytes = $0.int(0) }
            var result: [DuIndexNode] = []
            try query("""
                SELECT \(Self.nodeColumns) FROM dirs d
                WHERE d.parent_id = ?1 AND (d.flags & 16) = 0 AND d.alloc_bytes >= ?2
                ORDER BY \(sort.orderBy) LIMIT ?3
                """, [.int(node.id), .int(minBytes), .int(Int64(max(0, limit)))]) { row in
                var child = row.node()
                child.path = parentPath.map { Self.join($0, child.name) }
                if parentBytes > 0 { child.share = Double(child.allocBytes) / Double(parentBytes) }
                result.append(child)
            }
            // A flagged child (denied, incomplete, skipped, blocked) carries no bytes, so the size filter and the
            // limit would hide it; it is always listed, after the others, as `tools du index query` does.
            let listed = Set(result.map(\.id))
            try query("""
                SELECT \(Self.nodeColumns) FROM dirs d
                WHERE d.parent_id = ?1 AND (d.flags & 16) = 0 AND (d.flags & ?2) != 0
                ORDER BY d.name
                """, [.int(node.id), .int(Int64(DuIndexDirFlags.attention.rawValue))]) { row in
                var child = row.node()
                guard !listed.contains(child.id) else { return }
                child.path = parentPath.map { Self.join($0, child.name) }
                if parentBytes > 0 { child.share = Double(child.allocBytes) / Double(parentBytes) }
                result.append(child)
            }
            return result
        }
    }

    /// Rows with the blocked flag (not gone): `counts.blocked` of `tools du index query --info`.
    public func blockedDirCount() throws -> Int64 {
        try locked {
            var count: Int64 = 0
            try query("SELECT COUNT(*) FROM dirs WHERE (flags & 32) != 0 AND (flags & 16) = 0") { count = $0.int(0) }
            return count
        }
    }

    /// Blocked folders at or under `node`, as the query's `blocked_below`: 0 at once when the last walk blocked
    /// nothing (meta `blocked_dirs`), else each blocked row's parents are followed up to `node`.
    public func blockedBelow(_ node: DuIndexNode) throws -> Int64 {
        try transaction {
            var recorded: Int64 = 0
            try query("SELECT value FROM meta WHERE key = 'blocked_dirs'") { recorded = Int64($0.text(0)) ?? 0 }
            guard recorded > 0 else { return 0 }
            var blocked: [Int64] = []
            try query("SELECT id FROM dirs WHERE (flags & 32) != 0 AND (flags & 16) = 0") { blocked.append($0.int(0)) }
            var count: Int64 = 0
            for id in blocked {
                if try isAtOrUnder(id, ancestor: node.id) { count += 1 }
            }
            return count
        }
    }

    private func isAtOrUnder(_ id: Int64, ancestor: Int64) throws -> Bool {
        var current = id
        for _ in 0 ..< 4096 {
            if current == ancestor { return true }
            if current == 0 { return false }
            var parent: Int64?
            try query("SELECT parent_id FROM dirs WHERE id = ?1", [.int(current)]) { parent = $0.int(0) }
            guard let parent else { return false }
            current = parent
        }
        return false
    }

    /// What `node` holds outside its stored children: its own files and its folded subfolders.
    public func local(of node: DuIndexNode) throws -> DuIndexLocal {
        try transaction {
            // The node and its children from one read, so an update in between cannot make a size negative.
            var node = node
            try query("SELECT \(Self.nodeColumns) FROM dirs d WHERE d.id = ?1", [.int(node.id)]) { node = $0.node() }
            var local = DuIndexLocal(allocBytes: node.allocBytes, logicalBytes: node.logicalBytes,
                                     privateBytes: node.privateBytes, files: node.files, dirs: node.dirs)
            try query("""
                SELECT COALESCE(SUM(alloc_bytes), 0), COALESCE(SUM(logical_bytes), 0), SUM(private_bytes),
                       COALESCE(SUM(files), 0), COALESCE(SUM(dirs), 0), COUNT(*)
                FROM dirs WHERE parent_id = ?1 AND (flags & 16) = 0
                """, [.int(node.id)]) { row in
                local.allocBytes -= row.int(0)
                local.logicalBytes -= row.int(1)
                if let own = node.privateBytes { local.privateBytes = own - (row.optionalInt(2) ?? 0) }
                local.files -= row.int(3)
                // Each stored child is itself one of the folder's subfolders.
                local.dirs -= row.int(4) + row.int(5)
            }
            return local
        }
    }

    /// The largest indexed files under `folder` (a range scan on the path key).
    public func topFiles(under folder: String, limit: Int = 10) throws -> [DuIndexFile] {
        let base = Self.normalize(folder)
        if base == "/" { return try largestFiles(limit: limit) }
        return try locked {
            var result: [DuIndexFile] = []
            // '0' is the character after '/', so the range is exactly the paths below `base/`.
            try query("""
                SELECT path, logical_bytes, alloc_bytes, mtime_ms, nlink, dir_id FROM big_files
                WHERE path >= ?1 AND path < ?2 ORDER BY alloc_bytes DESC LIMIT ?3
                """, [.text(base + "/"), .text(base + "0"), .int(Int64(max(0, limit)))]) { result.append($0.file()) }
            return result
        }
    }

    public func largestFiles(limit: Int = 50) throws -> [DuIndexFile] {
        try locked {
            var result: [DuIndexFile] = []
            try query("SELECT path, logical_bytes, alloc_bytes, mtime_ms, nlink, dir_id FROM big_files ORDER BY alloc_bytes DESC LIMIT ?1",
                      [.int(Int64(max(0, limit)))]) { result.append($0.file()) }
            return result
        }
    }

    /// The most recent scans, newest first.
    public func scans(limit: Int = 10) throws -> [DuIndexScan] {
        try locked {
            var result: [DuIndexScan] = []
            try query("""
                SELECT id, kind, status, started_at_ms, finished_at_ms, files, dirs, alloc_bytes, walk_ms, threads
                FROM scans ORDER BY id DESC LIMIT ?1
                """, [.int(Int64(max(0, limit)))]) { row in
                result.append(DuIndexScan(id: row.int(0), kind: row.text(1), status: row.text(2), startedAtMs: row.int(3),
                                          finishedAtMs: row.optionalInt(4), files: row.optionalInt(5),
                                          dirs: row.optionalInt(6), allocBytes: row.optionalInt(7),
                                          walkMs: row.optionalInt(8), threads: row.optionalInt(9)))
            }
            return result
        }
    }

    /// The absolute path of a stored folder, from its parent chain.
    public func path(of id: Int64) throws -> String? {
        try transaction { try pathLocked(of: id) }
    }

    // MARK: - SQLite

    enum Value {
        case int(Int64)
        case text(String)
    }

    struct Row {
        let statement: OpaquePointer

        func int(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
        func optionalInt(_ column: Int32) -> Int64? {
            sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : sqlite3_column_int64(statement, column)
        }
        func text(_ column: Int32) -> String {
            sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
        }

        func node() -> DuIndexNode {
            DuIndexNode(id: int(0), parentId: int(1), name: text(2), allocBytes: int(3), logicalBytes: int(4),
                        privateBytes: optionalInt(5), files: int(6), dirs: int(7), maxFileBytes: int(8),
                        newestMtimeS: int(9), dirMtimeMs: int(10), flags: DuIndexDirFlags(rawValue: Int(int(11))),
                        scanId: int(12), storedChildren: int(13))
        }

        func file() -> DuIndexFile {
            DuIndexFile(path: text(0), logicalBytes: int(1), allocBytes: int(2), mtimeMs: int(3), nlink: int(4),
                        dirId: optionalInt(5))
        }
    }

    private func pathLocked(of id: Int64) throws -> String? {
        var names: [String] = []
        var current = id
        var guardSteps = 0
        while current != 0, guardSteps < 4096 {
            guardSteps += 1
            var found: (parent: Int64, name: String)?
            try query("SELECT parent_id, name FROM dirs WHERE id = ?1", [.int(current)]) { found = ($0.int(0), $0.text(1)) }
            guard let found else { return nil }
            names.append(found.name)
            current = found.parent
        }
        // A parent cycle (a damaged index) has no path.
        guard current == 0, let root = names.popLast() else { return nil }
        return names.reversed().reduce(root) { Self.join($0, $1) }
    }

    private func locked<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// Runs `body` inside one read transaction, so a multi-statement read sees one snapshot. A nested call joins
    /// the outer transaction.
    private func transaction<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        let outer = sqlite3_get_autocommit(db) != 0
        if outer { try execLocked("BEGIN") }
        defer { if outer { _ = try? execLocked("COMMIT") } }
        return try body()
    }

    private func execLocked(_ sql: String) throws {
        guard let db else { throw ReaderError.open("closed") }
        let code = sqlite3_exec(db, sql, nil, nil, nil)
        guard code == SQLITE_OK else {
            throw ReaderError.query(String(cString: sqlite3_errmsg(db)), busy: code == SQLITE_BUSY || code == SQLITE_LOCKED)
        }
    }

    private func query(_ sql: String, _ values: [Value] = [], _ each: (Row) throws -> Void) throws {
        guard let db else { throw ReaderError.open("closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw ReaderError.query(String(cString: sqlite3_errmsg(db)), busy: false)
        }
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case .int(let number): sqlite3_bind_int64(statement, position, number)
            case .text(let text): sqlite3_bind_text(statement, position, text, -1, Self.transient)
            }
        }
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_ROW {
                try each(Row(statement: statement))
            } else if code == SQLITE_DONE {
                return
            } else {
                throw ReaderError.query(String(cString: sqlite3_errmsg(db)), busy: code == SQLITE_BUSY || code == SQLITE_LOCKED)
            }
        }
    }

    // MARK: - Paths

    /// Doubled and trailing slashes removed; otherwise the spelling the index stored (no symlink resolution).
    static func normalize(_ path: String) -> String {
        var result = path
        while result.contains("//") { result = result.replacingOccurrences(of: "//", with: "/") }
        while result.count > 1, result.hasSuffix("/") { result.removeLast() }
        return result.isEmpty ? "/" : result
    }

    static func contains(_ root: String, _ path: String) -> Bool {
        root == "/" || path == root || path.hasPrefix(root + "/")
    }

    static func join(_ parent: String, _ name: String) -> String {
        parent == "/" ? "/" + name : parent + "/" + name
    }
}
