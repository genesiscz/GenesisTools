import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";

const dirs: string[] = [];

function legacyDbPath(build: (db: Database) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "yt-legacy-schema-"));
    dirs.push(dir);
    const path = join(dir, "youtube.db");
    const seed = new Database(path);
    build(seed);
    seed.close();
    return path;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("opening a database written by an older build", () => {
    it("upgrades a jobs table that predates the fingerprint column instead of throwing", () => {
        // The regression: initSchema indexed jobs(fingerprint) directly. On an
        // existing DB `CREATE TABLE IF NOT EXISTS jobs` is a no-op, so the
        // column was still missing when the index ran — SQLiteError "no such
        // column: fingerprint" escaped the constructor and killed the API
        // server at startup for every user with a pre-existing database.
        const path = legacyDbPath((seed) => {
            // The jobs table exactly as it shipped before params/fingerprint/
            // priority/user_id were introduced — those four are the only
            // columns any migration adds to it.
            seed.exec(`
                CREATE TABLE jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_kind TEXT NOT NULL,
                    target TEXT NOT NULL,
                    stages TEXT NOT NULL,
                    current_stage TEXT,
                    status TEXT NOT NULL,
                    error TEXT,
                    progress REAL NOT NULL DEFAULT 0,
                    progress_message TEXT,
                    parent_job_id INTEGER,
                    worker_id TEXT,
                    claimed_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    completed_at TEXT
                );
            `);
            seed.exec(
                "INSERT INTO jobs (target_kind, target, stages, status) VALUES ('video', 'vid00000001', '[\"metadata\"]', 'done')"
            );
        });

        const db = new YoutubeDatabase(path);

        try {
            const raw = db.getDb();
            const columns = raw
                .query<{ name: string }, []>("PRAGMA table_info(jobs)")
                .all()
                .map((c) => c.name);

            expect(columns).toContain("fingerprint");
            expect(columns).toContain("priority");
            expect(columns).toContain("params");

            const index = raw
                .query<{ name: string }, []>(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_fingerprint_active'"
                )
                .all();
            expect(index).toHaveLength(1);

            // The upgrade must not cost the user their existing rows.
            const rows = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs").get();
            expect(rows?.n).toBe(1);
        } finally {
            db.close();
        }
    });

    it("rebuilds ask_threads/ask_messages into ask_sessions without losing rows", () => {
        // `ask-threads-to-sessions` is the only destructive migration in initSchema:
        // it CREATEs new tables, copies every row across and DROPs the originals. A
        // fresh in-memory DB never enters that branch, so only a legacy fixture can
        // prove the copy is faithful.
        const path = legacyDbPath((seed) => {
            seed.exec(`
                CREATE TABLE ask_threads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    collection_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE ask_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    tool_name TEXT,
                    tool_args_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO ask_threads (id, user_id, collection_id, title, created_at, updated_at)
                    VALUES (7, 3, 11, 'weekly digest', '2026-01-01 00:00:00', '2026-01-02 00:00:00'),
                           (8, 4, 12, 'competitor watch', '2026-01-03 00:00:00', '2026-01-04 00:00:00');
                INSERT INTO ask_messages (id, thread_id, role, content, tool_name, tool_args_json)
                    VALUES (1, 7, 'user', 'what changed?', NULL, NULL),
                           (2, 7, 'assistant', 'three things', NULL, NULL),
                           (3, 7, 'tool', 'search', 'qa.search', '{"q":"changed"}'),
                           (4, 8, 'user', 'who shipped first?', NULL, NULL);
            `);
        });

        const db = new YoutubeDatabase(path);

        try {
            const raw = db.getDb();
            const legacyTables = raw
                .query<{ name: string }, []>(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ask_threads','ask_messages')"
                )
                .all();
            expect(legacyTables).toHaveLength(0);

            const sessions = raw
                .query<
                    { id: number; user_id: number; collection_id: number | null; scope_kind: string; title: string },
                    []
                >("SELECT id, user_id, collection_id, scope_kind, title FROM ask_sessions ORDER BY id")
                .all();
            expect(sessions).toEqual([
                { id: 7, user_id: 3, collection_id: 11, scope_kind: "collection", title: "weekly digest" },
                { id: 8, user_id: 4, collection_id: 12, scope_kind: "collection", title: "competitor watch" },
            ]);

            // Timestamps carry over verbatim — a migrated session must not look new.
            const migratedAt = raw
                .query<{ created_at: string; updated_at: string }, [number]>(
                    "SELECT created_at, updated_at FROM ask_sessions WHERE id = ?"
                )
                .get(7);
            expect(migratedAt).toEqual({ created_at: "2026-01-01 00:00:00", updated_at: "2026-01-02 00:00:00" });

            const messages = db.listAskSessionMessages(7);
            expect(messages.map((message) => [message.id, message.role, message.content])).toEqual([
                [1, "user", "what changed?"],
                [2, "assistant", "three things"],
                [3, "tool", "search"],
            ]);
            expect(messages[2]?.toolName).toBe("qa.search");
            expect(db.listAskSessionMessages(8)).toHaveLength(1);
        } finally {
            db.close();
        }
    });

    it("still builds the fingerprint index on a fresh database", () => {
        const db = new YoutubeDatabase(":memory:");

        try {
            const index = db
                .getDb()
                .query<{ name: string }, []>(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_fingerprint_active'"
                )
                .all();

            expect(index).toHaveLength(1);
        } finally {
            db.close();
        }
    });
});
