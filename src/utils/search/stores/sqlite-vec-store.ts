import type { Database } from "bun:sqlite";
import type { VectorSearchHit, VectorStore } from "./vector-store";

export interface SqliteVecVectorStoreConfig {
    tableName: string;
    dimensions: number;
}

/**
 * VectorStore backed by sqlite-vec extension -- uses vec0 virtual tables
 * for optimized brute-force KNN search entirely in C (no JS deserialization).
 *
 * Requires sqlite-vec to be loaded on the Database instance before construction:
 *   import { loadSqliteVec } from "./sqlite-vec-loader";
 *   loadSqliteVec(db);
 */
/** Max bind parameters per SQL IN(...) clause */
const SQL_BATCH_SIZE = 500;

export class SqliteVecVectorStore implements VectorStore {
    private db: Database;
    private vecTable: string;
    private dimensions: number;

    constructor(db: Database, config: SqliteVecVectorStoreConfig) {
        this.db = db;
        this.dimensions = config.dimensions;
        this.vecTable = `${config.tableName}_vec`;

        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTable} USING vec0(
            doc_id TEXT PRIMARY KEY,
            embedding float[${config.dimensions}] distance_metric=cosine
        )`);
    }

    store(id: string, vector: Float32Array): void {
        // vec0 doesn't support INSERT OR REPLACE -- DELETE then INSERT is the documented pattern.
        // The extra DELETE is fast (single-row PK lookup) and keeps the API safe for upserts.
        this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id = ?`, [id]);

        // Pass vector as raw blob (Float32Array buffer) for performance
        const blob = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        this.db.run(`INSERT INTO ${this.vecTable}(doc_id, embedding) VALUES (?, ?)`, [id, blob]);
    }

    remove(id: string): void {
        this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id = ?`, [id]);
    }

    removeMany(ids: string[]): void {
        if (ids.length === 0) {
            return;
        }

        for (let i = 0; i < ids.length; i += SQL_BATCH_SIZE) {
            const batch = ids.slice(i, i + SQL_BATCH_SIZE);
            const placeholders = batch.map(() => "?").join(",");
            this.db.run(`DELETE FROM ${this.vecTable} WHERE doc_id IN (${placeholders})`, batch);
        }
    }

    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
        // sqlite-vec KNN query: MATCH + k constraint + ORDER BY distance
        const blob = new Uint8Array(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

        const rows = this.db
            .query(
                `SELECT doc_id, distance
                FROM ${this.vecTable}
                WHERE embedding MATCH ?
                  AND k = ?
                ORDER BY distance`
            )
            .all(blob, limit) as Array<{ doc_id: string; distance: number }>;

        // With distance_metric=cosine, distance = 1 - cosine_similarity (range 0..2).
        // Convert to similarity: score = 1 - distance (range -1..1, typically 0..1 for normalized vectors).
        return rows.map((row) => ({
            docId: row.doc_id,
            score: 1 - row.distance,
        }));
    }

    count(): number {
        const row = this.db.query(`SELECT COUNT(*) AS cnt FROM ${this.vecTable}`).get() as {
            cnt: number;
        };
        return row.cnt;
    }
}
