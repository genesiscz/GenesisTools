import { cosineDistance } from "@app/utils/math";

export interface VectorSearchHit {
    docId: string;
    /** Cosine similarity (1 = identical, 0 = orthogonal) */
    score: number;
}

export interface VectorStore {
    store(id: string, vector: Float32Array): void;
    remove(id: string): void;
    /** Batch remove. Default: calls remove() per id. */
    removeMany?(ids: string[]): void;
    search(queryVector: Float32Array, limit: number): VectorSearchHit[];
    count(): number;
}

/** Brute-force in-memory vector search. Shared by stores that keep an in-memory mirror. */
export function bruteForceVectorSearch(
    memoryIndex: Map<string, Float32Array>,
    queryVector: Float32Array,
    limit: number,
): VectorSearchHit[] {
    const hits: VectorSearchHit[] = [];

    for (const [docId, storedVec] of memoryIndex) {
        const score = 1 - cosineDistance(queryVector, storedVec);
        hits.push({ docId, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
}
