import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tracks which Mail.app message ROWIDs have already been seen by the monitor.
 * Uses a SQLite database to persist state between runs.
 */
export class SeenStore {
    private db: Database;

    constructor(dbPath: string) {
        const dir = dirname(dbPath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS seen_messages (
                rowid INTEGER PRIMARY KEY,
                first_seen_at INTEGER NOT NULL
            )
        `);
    }

    /** Return all previously-seen rowids as a Set. */
    getSeenRowids(): Set<number> {
        const rows = this.db.prepare("SELECT rowid FROM seen_messages").all() as Array<{ rowid: number }>;
        return new Set(rows.map((r) => r.rowid));
    }

    /** Return the highest rowid ever recorded, or 0 if the table is empty. */
    getMaxSeenRowid(): number {
        const row = this.db.prepare("SELECT MAX(rowid) as maxId FROM seen_messages").get() as {
            maxId: number | null;
        };
        return row.maxId ?? 0;
    }

    /** Mark a batch of rowids as seen (upserts — safe to call with duplicates). */
    markSeen(rowids: number[]): void {
        if (rowids.length === 0) {
            return;
        }

        const stmt = this.db.prepare(
            "INSERT OR IGNORE INTO seen_messages (rowid, first_seen_at) VALUES (?, ?)"
        );
        const now = Math.floor(Date.now() / 1000);
        const tx = this.db.transaction(() => {
            for (const id of rowids) {
                stmt.run(id, now);
            }
        });
        tx();
    }

    /** Close the underlying database connection. */
    close(): void {
        this.db.close();
    }
}
