import type { Database } from "bun:sqlite";
import { loadSqliteVec } from "@app/utils/search/stores/sqlite-vec-loader";

/**
 * Count rows in whichever embedding-backing table is active for this index.
 * sqlite-vec writes into `<name>_vec`; the legacy bun-sqlite-brute driver
 * writes into `<name>_embeddings`. With sqlite-vec in use, `_embeddings` is
 * empty (or absent), so checking only that one yields a false 0.
 *
 * `_vec` is a virtual table backed by the vec0 module — querying it requires
 * sqlite-vec loaded on this specific connection. We load it on demand here so
 * callers (e.g. readonly stat readers) don't have to know about extensions.
 */
export function countActiveEmbeddings(db: Database, tableName: string): number {
    const vecTable = `${tableName}_vec`;
    const embTable = `${tableName}_embeddings`;
    const has = (t: string): boolean =>
        !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

    if (has(vecTable)) {
        try {
            const row = db.query(`SELECT COUNT(*) AS cnt FROM ${vecTable}`).get() as { cnt: number };
            return row.cnt;
        } catch {
            // vec0 module not loaded on this connection — load and retry once.
            if (loadSqliteVec(db)) {
                const row = db.query(`SELECT COUNT(*) AS cnt FROM ${vecTable}`).get() as { cnt: number };
                return row.cnt;
            }

            // sqlite-vec unavailable in this environment; treat as zero rather than crash stats.
            return 0;
        }
    }

    if (has(embTable)) {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${embTable}`).get() as { cnt: number };
        return row.cnt;
    }

    return 0;
}
