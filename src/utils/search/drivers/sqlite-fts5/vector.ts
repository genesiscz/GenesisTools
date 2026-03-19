import type { Database } from "bun:sqlite";
import { cosineDistance } from "@app/utils/math";

export function storeEmbedding(db: Database, table: string, docId: string, vector: Float32Array): void {
    const embTable = `${table}_embeddings`;
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

    db.run(`INSERT OR REPLACE INTO ${embTable} (doc_id, embedding) VALUES (?, ?)`, [docId, blob]);
}

export function removeEmbedding(db: Database, table: string, docId: string): void {
    const embTable = `${table}_embeddings`;
    db.run(`DELETE FROM ${embTable} WHERE doc_id = ?`, [docId]);
}

export interface VectorHit {
    docId: string;
    distance: number;
}

export interface VectorSearchTableConfig {
    /** Override the embeddings table name (default: `${table}_embeddings`) */
    table?: string;
    /** Column name for the doc ID (default: `doc_id`) */
    docIdColumn?: string;
}

export function vectorSearch(
    db: Database,
    table: string,
    queryVec: Float32Array,
    limit: number,
    tableConfig?: VectorSearchTableConfig
): VectorHit[] {
    const embTable = tableConfig?.table ?? `${table}_embeddings`;
    const docIdCol = tableConfig?.docIdColumn ?? "doc_id";
    const rows = db.query(`SELECT ${docIdCol} AS doc_id, embedding FROM ${embTable}`).all() as Array<{
        doc_id: string;
        embedding: Buffer;
    }>;

    const scored: VectorHit[] = [];

    for (const row of rows) {
        const storedVec = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4
        );
        const distance = cosineDistance(queryVec, storedVec);
        scored.push({ docId: row.doc_id, distance });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
}
