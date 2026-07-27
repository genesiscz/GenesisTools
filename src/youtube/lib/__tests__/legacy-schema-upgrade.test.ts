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
