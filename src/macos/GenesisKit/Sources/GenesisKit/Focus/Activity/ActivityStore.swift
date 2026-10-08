// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Activity/ActivityStore.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation
import SQLite3
import Darwin

/// Local-only activity ledger for Spec 22 (S6): pomodoro sessions plus the desktop focus
/// segments and input-effort counters they are measured against.
///
/// Lives at `~/.genesis/activity.db`, mode 0600, and is deliberately a **separate** database
/// from `genesis.db`: this data is high-volume, private, and is never served to anyone.
///
/// Thread-safety follows the house pattern (`Knowledge/VaultIndex.swift`): one serial queue,
/// synchronous-but-cheap public methods, migrations on open.
public final class ActivityStore {
    // MARK: - Types

    /// One contiguous stretch of a single (app, window, url) triple.
    public struct Segment: Equatable {
        public var id: Int64 = 0
        public var startedMs: Int64
        public var endedMs: Int64?
        public var sessionId: Int64?
        public var appBundle: String
        public var appName: String
        public var windowTitle: String?
        public var urlHost: String?
        public var urlPath: String?
        public var project: String?
        public var cmuxSession: String?
        public var cmuxPane: String?
        public var displayId: Int64?
        public var idle: Bool = false

        public var durationMs: Int64 { (endedMs ?? startedMs) - startedMs }
    }

    public enum SessionKind: String { case flow, shortBreak = "short_break", longBreak = "long_break" }
    public enum SessionState: String { case running, paused, done, abandoned }
    public enum PauseReason: String, Codable { case manual, idle, auto }

    public struct FocusSession: Equatable {
        public var id: Int64 = 0
        public var kind: String
        public var plannedSec: Int
        public var startedMs: Int64
        public var endedMs: Int64?
        public var state: String
        public var cycleIndex: Int
        public var tag: String?
        public var note: String?
        public var interruptions: Int = 0

        /// Wall-clock length, which is not `plannedSec` when the phase was skipped or overran.
        public var actualMs: Int64? { endedMs.map { $0 - startedMs } }
    }

    public struct InputCounts: Equatable {
        public var keys: Int = 0
        public var clicks: Int = 0
        public var scrolls: Int = 0
        public var px: Int = 0

        public static func + (a: InputCounts, b: InputCounts) -> InputCounts {
            InputCounts(keys: a.keys + b.keys, clicks: a.clicks + b.clicks,
                        scrolls: a.scrolls + b.scrolls, px: a.px + b.px)
        }
    }

    public enum StoreError: Error, CustomStringConvertible {
        case sqlite(String)

        public var description: String {
            switch self {
            case let .sqlite(message): return "activity store: \(message)"
            }
        }
    }

    // MARK: - Storage

    private var db: OpaquePointer?
    private var preparedStatements = 0
    var preparedStatementCount: Int { queue.sync { preparedStatements } }
    private let queue = DispatchQueue(label: "dev.genesis.activity-store")
    public let dbPath: String

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public static let defaultPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".genesis/activity.db").path

    public init(path: String = ActivityStore.defaultPath, readOnly: Bool = false) throws {
        dbPath = path
        if !readOnly, path != ":memory:" {
            let dir = (path as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            try Self.secureFile(path, create: true)
            for suffix in ["-wal", "-shm"] { try Self.secureFile(path + suffix, create: false) }
        }
        var handle: OpaquePointer?
        let flags = (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(handle)
            throw StoreError.sqlite(message)
        }
        db = handle
        sqlite3_busy_timeout(handle, 1_000)
        do {
            if !readOnly {
                try queue.sync { try migrate() }
                if path != ":memory:" {
                    for suffix in ["", "-wal", "-shm"] { try Self.secureFile(path + suffix, create: false) }
                }
            }
        } catch {
            sqlite3_close(handle)
            db = nil
            throw error
        }
    }

    private static func secureFile(_ path: String, create: Bool) throws {
        let descriptor = open(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT : 0), 0o600)
        if descriptor < 0, !create, errno == ENOENT { return }
        guard descriptor >= 0 else { throw StoreError.sqlite("cannot open private ledger file: \(String(cString: strerror(errno)))") }
        defer { close(descriptor) }
        guard fchmod(descriptor, 0o600) == 0 else { throw StoreError.sqlite("cannot secure ledger file: \(String(cString: strerror(errno)))") }
    }

    deinit { sqlite3_close(db) }

    // MARK: - Migration

    private func migrate() throws {
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA synchronous=NORMAL;")
        try exec("BEGIN IMMEDIATE;")
        var committed = false
        defer {
            if !committed {
                do { try exec("ROLLBACK;") }
                catch { FlowFocusLog.focus.error("ledger migration rollback failed: \(error.localizedDescription)") }
            }
        }
        try exec("""
        CREATE TABLE IF NOT EXISTS focus_session(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            planned_sec INTEGER NOT NULL,
            started_ms INTEGER NOT NULL,
            ended_ms INTEGER,
            state TEXT NOT NULL,
            cycle_index INTEGER NOT NULL DEFAULT 0,
            tag TEXT,
            note TEXT,
            interruptions INTEGER NOT NULL DEFAULT 0
        );
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS focus_pause(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            started_ms INTEGER NOT NULL,
            ended_ms INTEGER,
            reason TEXT NOT NULL
        );
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS activity_segment(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_ms INTEGER NOT NULL,
            ended_ms INTEGER,
            session_id INTEGER,
            app_bundle TEXT NOT NULL,
            app_name TEXT NOT NULL,
            window_title TEXT,
            url_host TEXT,
            url_path TEXT,
            project TEXT,
            cmux_session TEXT,
            cmux_pane TEXT,
            display_id INTEGER,
            idle INTEGER NOT NULL DEFAULT 0,
            is_closed INTEGER NOT NULL DEFAULT 0
        );
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS input_bucket(
            bucket_ms INTEGER NOT NULL,
            segment_id INTEGER NOT NULL,
            keys INTEGER NOT NULL DEFAULT 0,
            clicks INTEGER NOT NULL DEFAULT 0,
            scrolls INTEGER NOT NULL DEFAULT 0,
            px INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(bucket_ms, segment_id)
        );
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS capture_gap(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_ms INTEGER NOT NULL,
            ended_ms INTEGER,
            reason TEXT NOT NULL
        );
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS focus_intent(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            consumed_ms INTEGER
        );
        """)
        try exec("""
        CREATE TABLE IF NOT EXISTS day_rollup(
            day TEXT PRIMARY KEY,
            computed_ms INTEGER NOT NULL,
            json TEXT NOT NULL
        );
        """)
        try exec("CREATE INDEX IF NOT EXISTS idx_segment_started ON activity_segment(started_ms);")
        try exec("CREATE INDEX IF NOT EXISTS idx_segment_session ON activity_segment(session_id);")
        try exec("CREATE INDEX IF NOT EXISTS idx_segment_app ON activity_segment(app_bundle);")
        try exec("CREATE INDEX IF NOT EXISTS idx_session_started ON focus_session(started_ms);")
        let columns = try prepare("PRAGMA table_info(activity_segment);")
        var hasClosed = false
        while sqlite3_step(columns) == SQLITE_ROW {
            if text(columns, 1) == "is_closed" { hasClosed = true }
        }
        sqlite3_finalize(columns)
        if !hasClosed {
            try exec("ALTER TABLE activity_segment ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0;")
            try exec("UPDATE activity_segment SET is_closed=1 WHERE ended_ms IS NOT NULL;")
        }
        try exec("COMMIT;")
        committed = true
    }

    // MARK: - Segments

    /// Opens a segment and returns its id. The caller closes it when focus moves.
    @discardableResult
    public func openSegment(_ segment: Segment) throws -> Int64 {
        try queue.sync {
            let sql = """
            INSERT INTO activity_segment(
                started_ms, ended_ms, session_id, app_bundle, app_name, window_title,
                url_host, url_path, project, cmux_session, cmux_pane, display_id, idle, is_closed)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?);
            """
            let stmt = try prepare(sql)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, segment.startedMs)
            bindOptionalInt(stmt, 2, segment.endedMs)
            bindOptionalInt(stmt, 3, segment.sessionId)
            bindText(stmt, 4, segment.appBundle)
            bindText(stmt, 5, segment.appName)
            bindOptionalText(stmt, 6, segment.windowTitle)
            bindOptionalText(stmt, 7, segment.urlHost)
            bindOptionalText(stmt, 8, segment.urlPath)
            bindOptionalText(stmt, 9, segment.project)
            bindOptionalText(stmt, 10, segment.cmuxSession)
            bindOptionalText(stmt, 11, segment.cmuxPane)
            bindOptionalInt(stmt, 12, segment.displayId)
            sqlite3_bind_int(stmt, 13, segment.idle ? 1 : 0)
            sqlite3_bind_int(stmt, 14, segment.endedMs == nil ? 0 : 1)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
            return sqlite3_last_insert_rowid(db)
        }
    }

    /// Closes an open segment. Closing an already-closed segment is a no-op, so a duplicate
    /// focus notification can never shorten a stretch that was already recorded.
    public func closeSegment(id: Int64, at endedMs: Int64) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE activity_segment SET ended_ms=MAX(COALESCE(ended_ms,started_ms),?), is_closed=1 WHERE id=? AND is_closed=0;")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, endedMs)
            sqlite3_bind_int64(stmt, 2, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    /// Moves an open segment's provisional end forward. The recorder calls this every tick, so
    /// a segment that is still open on disk is never more than one tick stale. That is what lets
    /// a crash or a quit be bounded: whatever the last touch says is where the record stops.
    public func touchSegment(id: Int64, at endedMs: Int64) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE activity_segment SET ended_ms=MAX(COALESCE(ended_ms,started_ms),?) WHERE id=? AND is_closed=0;")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, endedMs)
            sqlite3_bind_int64(stmt, 2, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    /// The last moment anything was recorded, across segments and input buckets. Launch uses it
    /// as the start of the "app was not running" gap.
    public func lastRecordedMs() throws -> Int64? {
        try queue.sync {
            let stmt = try prepare("""
            SELECT MAX(value) FROM (
                SELECT MAX(COALESCE(ended_ms, started_ms)) AS value FROM activity_segment
                UNION ALL
                SELECT MAX(bucket_ms + 60000) FROM input_bucket
            );
            """)
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
            return optionalInt(stmt, 0)
        }
    }

    /// Segments left open by an unclean exit, so launch can finish them honestly.
    public func openSegments() throws -> [Segment] {
        try segmentsWhere("is_closed=0")
    }

    /// Attaches a segment to a pomodoro session after the fact (a flow can start mid-segment).
    public func attachSegment(id: Int64, toSession sessionId: Int64?) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE activity_segment SET session_id=? WHERE id=?;")
            defer { sqlite3_finalize(stmt) }
            bindOptionalInt(stmt, 1, sessionId)
            sqlite3_bind_int64(stmt, 2, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    public func segments(from: Int64, to: Int64) throws -> [Segment] {
        try queue.sync {
            let sql = """
            SELECT id, started_ms, ended_ms, session_id, app_bundle, app_name, window_title,
                   url_host, url_path, project, cmux_session, cmux_pane, display_id, idle
            FROM activity_segment
            WHERE started_ms < ? AND (ended_ms IS NULL OR ended_ms > ?)
            ORDER BY started_ms ASC;
            """
            let stmt = try prepare(sql)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, to)
            sqlite3_bind_int64(stmt, 2, from)
            var rows: [Segment] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append(Segment(
                    id: sqlite3_column_int64(stmt, 0),
                    startedMs: sqlite3_column_int64(stmt, 1),
                    endedMs: optionalInt(stmt, 2),
                    sessionId: optionalInt(stmt, 3),
                    appBundle: text(stmt, 4) ?? "",
                    appName: text(stmt, 5) ?? "",
                    windowTitle: text(stmt, 6),
                    urlHost: text(stmt, 7),
                    urlPath: text(stmt, 8),
                    project: text(stmt, 9),
                    cmuxSession: text(stmt, 10),
                    cmuxPane: text(stmt, 11),
                    displayId: optionalInt(stmt, 12),
                    idle: sqlite3_column_int(stmt, 13) == 1))
            }
            return rows
        }
    }

    private func segmentsWhere(_ clause: String) throws -> [Segment] {
        try queue.sync {
            let stmt = try prepare("""
            SELECT id, started_ms, ended_ms, session_id, app_bundle, app_name, window_title,
                   url_host, url_path, project, cmux_session, cmux_pane, display_id, idle
            FROM activity_segment WHERE \(clause) ORDER BY started_ms ASC;
            """)
            defer { sqlite3_finalize(stmt) }
            var rows: [Segment] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append(Segment(
                    id: sqlite3_column_int64(stmt, 0),
                    startedMs: sqlite3_column_int64(stmt, 1),
                    endedMs: optionalInt(stmt, 2),
                    sessionId: optionalInt(stmt, 3),
                    appBundle: text(stmt, 4) ?? "",
                    appName: text(stmt, 5) ?? "",
                    windowTitle: text(stmt, 6),
                    urlHost: text(stmt, 7),
                    urlPath: text(stmt, 8),
                    project: text(stmt, 9),
                    cmuxSession: text(stmt, 10),
                    cmuxPane: text(stmt, 11),
                    displayId: optionalInt(stmt, 12),
                    idle: sqlite3_column_int(stmt, 13) == 1))
            }
            return rows
        }
    }

    // MARK: - Input counters

    /// Adds counts to a one-minute bucket. Counts only — the schema has nowhere to put a keycode.
    public func appendInput(bucketMs: Int64, segmentId: Int64, counts: InputCounts) throws {
        try queue.sync {
            let sql = """
            INSERT INTO input_bucket(bucket_ms, segment_id, keys, clicks, scrolls, px)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(bucket_ms, segment_id) DO UPDATE SET
                keys = keys + excluded.keys,
                clicks = clicks + excluded.clicks,
                scrolls = scrolls + excluded.scrolls,
                px = px + excluded.px;
            """
            let stmt = try prepare(sql)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, bucketMs)
            sqlite3_bind_int64(stmt, 2, segmentId)
            sqlite3_bind_int64(stmt, 3, Int64(counts.keys))
            sqlite3_bind_int64(stmt, 4, Int64(counts.clicks))
            sqlite3_bind_int64(stmt, 5, Int64(counts.scrolls))
            sqlite3_bind_int64(stmt, 6, Int64(counts.px))
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    public func inputTotals(from: Int64, to: Int64) throws -> InputCounts {
        try queue.sync {
            let stmt = try prepare("""
            SELECT COALESCE(SUM(keys),0), COALESCE(SUM(clicks),0), COALESCE(SUM(scrolls),0), COALESCE(SUM(px),0)
            FROM input_bucket WHERE bucket_ms >= ? AND bucket_ms < ?;
            """)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, from)
            sqlite3_bind_int64(stmt, 2, to)
            guard sqlite3_step(stmt) == SQLITE_ROW else { return InputCounts() }
            return InputCounts(keys: Int(sqlite3_column_int64(stmt, 0)),
                               clicks: Int(sqlite3_column_int64(stmt, 1)),
                               scrolls: Int(sqlite3_column_int64(stmt, 2)),
                               px: Int(sqlite3_column_int64(stmt, 3)))
        }
    }

    public struct InputSample: Equatable {
        public let bucketMs: Int64
        public let segmentId: Int64
        public let counts: InputCounts
    }

    /// The one-minute buckets themselves rather than their sum, so effort can be drawn over
    /// time instead of collapsed into a single number.
    public func inputSeries(from: Int64, to: Int64) throws -> [InputSample] {
        try queue.sync {
            let stmt = try prepare("""
            SELECT bucket_ms, segment_id, keys, clicks, scrolls, px FROM input_bucket
            WHERE bucket_ms >= ? AND bucket_ms < ? ORDER BY bucket_ms ASC;
            """)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, from)
            sqlite3_bind_int64(stmt, 2, to)
            var rows: [InputSample] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append(InputSample(
                    bucketMs: sqlite3_column_int64(stmt, 0),
                    segmentId: sqlite3_column_int64(stmt, 1),
                    counts: InputCounts(keys: Int(sqlite3_column_int64(stmt, 2)),
                                        clicks: Int(sqlite3_column_int64(stmt, 3)),
                                        scrolls: Int(sqlite3_column_int64(stmt, 4)),
                                        px: Int(sqlite3_column_int64(stmt, 5)))))
            }
            return rows
        }
    }

    /// A gap is recorded when the event tap dies, so a quiet hour reads as "not measured"
    /// rather than "you did nothing".
    @discardableResult
    public func recordGap(startedMs: Int64, endedMs: Int64?, reason: String) throws -> Int64 {
        try queue.sync {
            let stmt = try prepare("INSERT INTO capture_gap(started_ms, ended_ms, reason) VALUES(?,?,?);")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, startedMs)
            bindOptionalInt(stmt, 2, endedMs)
            bindText(stmt, 3, reason)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
            return sqlite3_last_insert_rowid(db)
        }
    }

    public struct Gap: Equatable {
        public var id: Int64
        public var startedMs: Int64
        public var endedMs: Int64?
        public var reason: String
    }

    public func gaps(from: Int64, to: Int64) throws -> [Gap] {
        try queue.sync {
            let stmt = try prepare("""
            SELECT id, started_ms, ended_ms, reason FROM capture_gap
            WHERE started_ms < ? AND (ended_ms IS NULL OR ended_ms > ?)
            ORDER BY started_ms ASC;
            """)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, to)
            sqlite3_bind_int64(stmt, 2, from)
            var rows: [Gap] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append(Gap(id: sqlite3_column_int64(stmt, 0),
                                startedMs: sqlite3_column_int64(stmt, 1),
                                endedMs: optionalInt(stmt, 2),
                                reason: text(stmt, 3) ?? ""))
            }
            return rows
        }
    }

    public func closeGap(id: Int64, at endedMs: Int64) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE capture_gap SET ended_ms=? WHERE id=? AND ended_ms IS NULL;")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, endedMs)
            sqlite3_bind_int64(stmt, 2, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    // MARK: - Sessions

    @discardableResult
    public func startSession(_ session: FocusSession) throws -> Int64 {
        try queue.sync {
            let sql = """
            INSERT INTO focus_session(kind, planned_sec, started_ms, ended_ms, state, cycle_index, tag, note, interruptions)
            VALUES(?,?,?,?,?,?,?,?,?);
            """
            let stmt = try prepare(sql)
            defer { sqlite3_finalize(stmt) }
            bindText(stmt, 1, session.kind)
            sqlite3_bind_int(stmt, 2, Int32(session.plannedSec))
            sqlite3_bind_int64(stmt, 3, session.startedMs)
            bindOptionalInt(stmt, 4, session.endedMs)
            bindText(stmt, 5, session.state)
            sqlite3_bind_int(stmt, 6, Int32(session.cycleIndex))
            bindOptionalText(stmt, 7, session.tag)
            bindOptionalText(stmt, 8, session.note)
            sqlite3_bind_int(stmt, 9, Int32(session.interruptions))
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
            return sqlite3_last_insert_rowid(db)
        }
    }

    public func endSession(id: Int64, at endedMs: Int64, state: SessionState) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE focus_session SET ended_ms=?, state=? WHERE id=?;")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, endedMs)
            bindText(stmt, 2, state.rawValue)
            sqlite3_bind_int64(stmt, 3, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    public func updateSession(id: Int64, tag: String?, note: String?, interruptions: Int?) throws {
        try queue.sync {
            let stmt = try prepare("""
            UPDATE focus_session SET
                tag = COALESCE(?, tag),
                note = COALESCE(?, note),
                interruptions = COALESCE(?, interruptions)
            WHERE id=?;
            """)
            defer { sqlite3_finalize(stmt) }
            bindOptionalText(stmt, 1, tag)
            bindOptionalText(stmt, 2, note)
            if let interruptions { sqlite3_bind_int(stmt, 3, Int32(interruptions)) } else { sqlite3_bind_null(stmt, 3) }
            sqlite3_bind_int64(stmt, 4, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    /// The session the app was in when it died, if any. Crash resume reads this first.
    public func openSession() throws -> FocusSession? {
        try sessionsWhere("state IN ('running','paused') ORDER BY started_ms DESC LIMIT 1").first
    }

    public func sessions(from: Int64, to: Int64) throws -> [FocusSession] {
        try sessionsWhere("started_ms >= \(from) AND started_ms < \(to) ORDER BY started_ms ASC")
    }

    /// One session by id, for the per-session breakdown window.
    public func session(id: Int64) throws -> FocusSession? {
        try sessionsWhere("id = \(id) LIMIT 1").first
    }

    private func sessionsWhere(_ clause: String) throws -> [FocusSession] {
        try queue.sync {
            let sql = """
            SELECT id, kind, planned_sec, started_ms, ended_ms, state, cycle_index, tag, note, interruptions
            FROM focus_session WHERE \(clause);
            """
            let stmt = try prepare(sql)
            defer { sqlite3_finalize(stmt) }
            var rows: [FocusSession] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append(FocusSession(
                    id: sqlite3_column_int64(stmt, 0),
                    kind: text(stmt, 1) ?? "flow",
                    plannedSec: Int(sqlite3_column_int(stmt, 2)),
                    startedMs: sqlite3_column_int64(stmt, 3),
                    endedMs: optionalInt(stmt, 4),
                    state: text(stmt, 5) ?? "done",
                    cycleIndex: Int(sqlite3_column_int(stmt, 6)),
                    tag: text(stmt, 7),
                    note: text(stmt, 8),
                    interruptions: Int(sqlite3_column_int(stmt, 9))))
            }
            return rows
        }
    }

    @discardableResult
    public func recordPause(sessionId: Int64, startedMs: Int64, endedMs: Int64?, reason: PauseReason) throws -> Int64 {
        try queue.sync {
            let stmt = try prepare("INSERT INTO focus_pause(session_id, started_ms, ended_ms, reason) VALUES(?,?,?,?);")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, sessionId)
            sqlite3_bind_int64(stmt, 2, startedMs)
            bindOptionalInt(stmt, 3, endedMs)
            bindText(stmt, 4, reason.rawValue)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
            return sqlite3_last_insert_rowid(db)
        }
    }

    /// Writes the session's state without ending it. Pausing has to survive a restart, and the
    /// only record of "paused" was an open pause row, which the resume path could not see
    /// because the session still said `running`.
    public func setSessionState(id: Int64, state: SessionState) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE focus_session SET state=? WHERE id=? AND ended_ms IS NULL;")
            defer { sqlite3_finalize(stmt) }
            bindText(stmt, 1, state.rawValue)
            sqlite3_bind_int64(stmt, 2, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    public func closePause(id: Int64, at endedMs: Int64) throws {
        try queue.sync {
            let stmt = try prepare("UPDATE focus_pause SET ended_ms=? WHERE id=? AND ended_ms IS NULL;")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, endedMs)
            sqlite3_bind_int64(stmt, 2, id)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    public struct Pause: Equatable {
        public let id: Int64
        public let startedMs: Int64
        public let endedMs: Int64?
        public let reason: String
    }

    /// Every pause inside one session, oldest first. `pausedMs` answers "how long"; this
    /// answers "when, and why", which is what a breakdown has to draw.
    public func pauses(sessionId: Int64) throws -> [Pause] {
        try queue.sync {
            let stmt = try prepare("""
            SELECT id, started_ms, ended_ms, reason FROM focus_pause
            WHERE session_id=? ORDER BY started_ms ASC;
            """)
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, sessionId)
            var rows: [Pause] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append(Pause(id: sqlite3_column_int64(stmt, 0),
                                  startedMs: sqlite3_column_int64(stmt, 1),
                                  endedMs: optionalInt(stmt, 2),
                                  reason: text(stmt, 3) ?? "manual"))
            }
            return rows
        }
    }

    /// Paused milliseconds inside a session, so "actual focused time" excludes them.
    ///
    /// **Overlapping rows are merged, never summed.** Two processes, or one process restarted
    /// while paused, can leave two pause rows covering the same minutes; adding them up charges
    /// that time twice and the phase clock runs backwards. Measured 2026-09-21 on a live flow:
    /// 248 seconds of real pauses were reported as 6,844.
    public func pausedMs(sessionId: Int64, now: Int64) throws -> Int64 {
        let spans = try pauses(sessionId: sessionId).map {
            (start: $0.startedMs, end: $0.endedMs ?? now)
        }.filter { $0.end > $0.start }.sorted { $0.start < $1.start }

        var total: Int64 = 0
        var current: (start: Int64, end: Int64)?
        for span in spans {
            guard var open = current else {
                current = span
                continue
            }
            if span.start <= open.end {
                open.end = max(open.end, span.end)
                current = open
            } else {
                total += open.end - open.start
                current = span
            }
        }
        if let open = current { total += open.end - open.start }
        return total
    }

    /// Pause rows of a session that were never closed, newest first.
    public func openPauses(sessionId: Int64) throws -> [Pause] {
        try pauses(sessionId: sessionId).filter { $0.endedMs == nil }.reversed()
    }

    /// Closes pause rows nobody is left to close.
    ///
    /// A process killed while paused leaves its row open, and an open row counts up to `now`
    /// forever — so every restart-while-paused adds phantom paused time to the same session.
    ///
    /// Each orphan is closed where the EVIDENCE says it ended, in this order: the next pause of
    /// the same session, else the last moment anything was recorded, else its own start. The
    /// last case is deliberate: a pause nothing can corroborate is worth zero, because crediting
    /// it hands back time the user never actually spent paused.
    @discardableResult
    public func closeOrphanedPauses(sessionId: Int64, keeping keepId: Int64?, now: Int64) throws -> Int {
        let orphans = try openPauses(sessionId: sessionId).filter { $0.id != keepId }
        guard !orphans.isEmpty else { return 0 }
        let all = try pauses(sessionId: sessionId)
        let lastSeen = try lastRecordedMs()
        for orphan in orphans {
            let nextStart = all
                .filter { $0.startedMs > orphan.startedMs }
                .map(\.startedMs)
                .min()
            let evidence = nextStart ?? lastSeen ?? orphan.startedMs
            let end = min(now, max(orphan.startedMs, evidence))
            try closePause(id: orphan.id, at: end)
        }
        return orphans.count
    }

    // MARK: - Deletion (the privacy path)

    /// Deletes everything recorded in a range, optionally for one app only, and reports what went.
    @discardableResult
    public func forget(from: Int64, to: Int64, appBundle: String? = nil) throws -> (segments: Int, sessions: Int) {
        guard from < to else { return (0, 0) }
        return try queue.sync {
            try exec("BEGIN IMMEDIATE;")
            var committed = false
            defer {
                if !committed {
                    do { try exec("ROLLBACK;") }
                    catch { FlowFocusLog.focus.error("ledger forget rollback failed: \(error.localizedDescription)") }
                }
            }
            func run(_ sql: String, _ values: [Int64], app: String? = nil) throws -> Int {
                let statement = try prepare(sql)
                defer { sqlite3_finalize(statement) }
                for (index, value) in values.enumerated() { sqlite3_bind_int64(statement, Int32(index + 1), value) }
                if let app { bindText(statement, Int32(values.count + 1), app) }
                guard sqlite3_step(statement) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
                return Int(sqlite3_changes(db))
            }
            var clause = "started_ms >= ? AND started_ms < ?"
            if appBundle != nil { clause += " AND app_bundle = ?" }
            _ = try run("DELETE FROM input_bucket WHERE segment_id IN (SELECT id FROM activity_segment WHERE \(clause));", [from, to], app: appBundle)
            let segments = try run("DELETE FROM activity_segment WHERE \(clause);", [from, to], app: appBundle)
            var sessions = 0
            if appBundle == nil {
                _ = try run("DELETE FROM focus_pause WHERE session_id IN (SELECT id FROM focus_session WHERE started_ms >= ? AND started_ms < ?);", [from, to])
                sessions = try run("DELETE FROM focus_session WHERE started_ms >= ? AND started_ms < ?;", [from, to])
                // Preserve both outside fragments of a gap spanning the forgotten interval.
                _ = try run("INSERT INTO capture_gap(started_ms,ended_ms,reason) SELECT ?,ended_ms,reason FROM capture_gap WHERE started_ms < ? AND (ended_ms IS NULL OR ended_ms > ?);", [to, from, to])
                _ = try run("UPDATE capture_gap SET ended_ms=? WHERE started_ms < ? AND (ended_ms IS NULL OR ended_ms > ?);", [from, from, from])
                _ = try run("DELETE FROM capture_gap WHERE started_ms >= ? AND started_ms < ? AND ended_ms IS NOT NULL AND ended_ms <= ?;", [from, to, to])
                _ = try run("UPDATE capture_gap SET started_ms=? WHERE started_ms >= ? AND started_ms < ?;", [to, from, to])
            }
            try exec("DELETE FROM day_rollup;")
            try exec("COMMIT;")
            committed = true
            return (segments, sessions)
        }
    }

    // MARK: - Intents (the CLI's only write)

    /// One queued command from `genesis focus …`. The CLI appends; the app consumes exactly once.
    public struct Intent: Equatable {
        public var id: Int64
        public var kind: String
        public var payload: [String: Any]

        public static func == (a: Intent, b: Intent) -> Bool { a.id == b.id && a.kind == b.kind }
    }

    /// Returns unconsumed intents and marks them consumed in the same queue hop, so two drains
    /// can never run the same command twice.
    public func takeIntents(limit: Int = 16) throws -> [Intent] {
        try queue.sync {
            let stmt = try prepare("SELECT id, kind, payload FROM focus_intent WHERE consumed_ms IS NULL ORDER BY id ASC LIMIT ?;")
            var rows: [Intent] = []
            sqlite3_bind_int(stmt, 1, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                let raw = text(stmt, 2) ?? "{}"
                let payload = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
                rows.append(Intent(id: sqlite3_column_int64(stmt, 0), kind: text(stmt, 1) ?? "", payload: payload))
            }
            sqlite3_finalize(stmt)
            guard !rows.isEmpty else { return [] }

            let now = Int64(Date().timeIntervalSince1970 * 1000)
            for row in rows {
                let mark = try prepare("UPDATE focus_intent SET consumed_ms=? WHERE id=?;")
                sqlite3_bind_int64(mark, 1, now)
                sqlite3_bind_int64(mark, 2, row.id)
                _ = sqlite3_step(mark)
                sqlite3_finalize(mark)
            }
            return rows
        }
    }

    /// Test seam and parity with the CLI writer.
    @discardableResult
    public func pushIntent(kind: String, payload: [String: Any] = [:]) throws -> Int64 {
        try queue.sync {
            let stmt = try prepare("INSERT INTO focus_intent(created_ms, kind, payload) VALUES(?,?,?);")
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, Int64(Date().timeIntervalSince1970 * 1000))
            bindText(stmt, 2, kind)
            let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
            bindText(stmt, 3, String(data: data, encoding: .utf8) ?? "{}")
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
            return sqlite3_last_insert_rowid(db)
        }
    }

    // MARK: - Rollups

    public func cacheRollup(day: String, json: String, computedMs: Int64) throws {
        try queue.sync {
            let stmt = try prepare("INSERT INTO day_rollup(day, computed_ms, json) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET computed_ms=excluded.computed_ms, json=excluded.json;")
            defer { sqlite3_finalize(stmt) }
            bindText(stmt, 1, day)
            sqlite3_bind_int64(stmt, 2, computedMs)
            bindText(stmt, 3, json)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.sqlite(lastMessage()) }
        }
    }

    public func cachedRollup(day: String) throws -> String? {
        try queue.sync {
            let stmt = try prepare("SELECT json FROM day_rollup WHERE day=?;")
            defer { sqlite3_finalize(stmt) }
            bindText(stmt, 1, day)
            guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
            return text(stmt, 0)
        }
    }

    // MARK: - SQLite helpers

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        preparedStatements += 1
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.sqlite(lastMessage())
        }
        return stmt
    }

    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw StoreError.sqlite(lastMessage())
        }
    }

    /// `exec` from inside a method that already holds the queue.
    private func execUnsafe(_ sql: String) throws { try exec(sql) }

    private func lastMessage() -> String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown sqlite error"
    }

    private func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(stmt, index, value, -1, Self.transient)
    }

    private func bindOptionalText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String?) {
        if let value { sqlite3_bind_text(stmt, index, value, -1, Self.transient) } else { sqlite3_bind_null(stmt, index) }
    }

    private func bindOptionalInt(_ stmt: OpaquePointer?, _ index: Int32, _ value: Int64?) {
        if let value { sqlite3_bind_int64(stmt, index, value) } else { sqlite3_bind_null(stmt, index) }
    }

    private func optionalInt(_ stmt: OpaquePointer?, _ index: Int32) -> Int64? {
        sqlite3_column_type(stmt, index) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, index)
    }

    private func text(_ stmt: OpaquePointer?, _ index: Int32) -> String? {
        guard let raw = sqlite3_column_text(stmt, index) else { return nil }
        return String(cString: raw)
    }
}
