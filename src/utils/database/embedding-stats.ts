import type { Database } from "bun:sqlite";

/**
 * Count rows in whichever embedding-backing table is active for this index.
 * sqlite-vec writes into `<name>_vec`; the legacy bun-sqlite-brute driver
 * writes into `<name>_embeddings`. With sqlite-vec in use, `_embeddings` is
 * empty (or absent), so checking only that one yields a false 0.
 */
export function countActiveEmbeddings(db: Database, tableName: string): number {
    const vecTable = `${tableName}_vec`;
    const embTable = `${tableName}_embeddings`;
    const has = (t: string): boolean =>
        !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

    if (has(vecTable)) {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${vecTable}`).get() as { cnt: number };
        return row.cnt;
    }

    if (has(embTable)) {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${embTable}`).get() as { cnt: number };
        return row.cnt;
    }

    return 0;
}
