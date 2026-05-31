/**
 * Shared math utilities.
 */

/**
 * Compute cosine distance between two vectors.
 * Returns 0 for identical vectors, 2 for opposite vectors.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);

    if (denom === 0) {
        return 2;
    }

    return 1 - dot / denom;
}
