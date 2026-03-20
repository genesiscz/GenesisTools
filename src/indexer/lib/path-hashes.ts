import type { Database } from "bun:sqlite";

export class PathHashStore {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
        this.db.run(`CREATE TABLE IF NOT EXISTS path_hashes (
            path TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            is_file INTEGER NOT NULL DEFAULT 1
        )`);
    }

    upsert(path: string, hash: string, isFile: boolean): void {
        this.db.run("INSERT OR REPLACE INTO path_hashes (path, hash, is_file) VALUES (?, ?, ?)", [
            path,
            hash,
            isFile ? 1 : 0,
        ]);
    }

    remove(path: string): void {
        this.db.run("DELETE FROM path_hashes WHERE path = ?", [path]);
    }

    getHash(path: string): string | null {
        const row = this.db.query("SELECT hash FROM path_hashes WHERE path = ?").get(path) as {
            hash: string;
        } | null;
        return row?.hash ?? null;
    }

    getFileCount(): number {
        const row = this.db.query("SELECT COUNT(*) AS cnt FROM path_hashes WHERE is_file = 1").get() as { cnt: number };
        return row.cnt;
    }

    getMaxNumericPath(): number {
        const row = this.db.query(
            "SELECT MAX(CAST(path AS INTEGER)) AS maxId FROM path_hashes WHERE is_file = 1 AND path GLOB '[0-9]*'"
        ).get() as { maxId: number | null };
        return row.maxId ?? 0;
    }

    getAllFiles(): Map<string, string> {
        const rows = this.db.query("SELECT path, hash FROM path_hashes WHERE is_file = 1").all() as Array<{
            path: string;
            hash: string;
        }>;
        const map = new Map<string, string>();

        for (const row of rows) {
            map.set(row.path, row.hash);
        }

        return map;
    }

    bulkSync(current: Array<{ path: string; hash: string; isFile: boolean }>): void {
        const currentPaths = new Set(current.map((c) => c.path));
        const tx = this.db.transaction(() => {
            const existing = this.db.query("SELECT path FROM path_hashes").all() as Array<{ path: string }>;

            for (const row of existing) {
                if (!currentPaths.has(row.path)) {
                    this.remove(row.path);
                }
            }

            for (const entry of current) {
                this.upsert(entry.path, entry.hash, entry.isFile);
            }
        });
        tx();
    }
}
