export interface VectorSearchHit {
    docId: string;
    /** Cosine similarity (1 = identical, 0 = orthogonal) */
    score: number;
}

export interface VectorStore {
    store(id: string, vector: Float32Array): void;
    remove(id: string): void;
    search(queryVector: Float32Array, limit: number): VectorSearchHit[];
    count(): number;
}
