import type { Database } from "bun:sqlite";
import { cosineDistance } from "@app/utils/math";
import type { VectorSearchHit, VectorStore } from "./vector-store";

export interface SqliteVectorStoreConfig {
    tableName: string;
    dimensions: number;
}

export class SqliteVectorStore implements VectorStore {
    private db: Database;
    private embTable: string;

    constructor(db: Database, config: SqliteVectorStoreConfig) {
        this.db = db;
        this.embTable = `${config.tableName}_embeddings`;

        this.db.run(`CREATE TABLE IF NOT EXISTS ${this.embTable} (
            doc_id TEXT PRIMARY KEY,
            embedding BLOB NOT NULL
        )`);
    }

    store(id: string, vector: Float32Array): void {
        const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        this.db.run(`INSERT OR REPLACE INTO ${this.embTable} (doc_id, embedding) VALUES (?, ?)`, [id, blob]);
    }

    remove(id: string): void {
        this.db.run(`DELETE FROM ${this.embTable} WHERE doc_id = ?`, [id]);
    }

    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
        const rows = this.db.query(`SELECT doc_id, embedding FROM ${this.embTable}`).all() as Array<{
            doc_id: string;
            embedding: Buffer;
        }>;

        const scored: VectorSearchHit[] = [];

        for (const row of rows) {
            const storedVec = new Float32Array(
                row.embedding.buffer,
                row.embedding.byteOffset,
                row.embedding.byteLength / 4
            );

            // Skip zero-magnitude vectors (failed embeddings)
            let mag = 0;

            for (let i = 0; i < storedVec.length; i++) {
                mag += storedVec[i] * storedVec[i];
            }

            if (mag === 0) {
                continue;
            }

            const distance = cosineDistance(queryVector, storedVec);
            scored.push({ docId: row.doc_id, score: 1 - distance });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    }

    count(): number {
        const row = this.db.query(`SELECT COUNT(*) AS cnt FROM ${this.embTable}`).get() as { cnt: number };
        return row.cnt;
    }
}
