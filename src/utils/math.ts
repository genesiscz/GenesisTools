/**
 * Shared math utilities.
 */

/**
 * Largest value in an iterable, without `Math.max(...iterable)`.
 *
 * The spread passes one ARGUMENT per element, and every engine caps the argument count, so
 * the idiomatic one-liner throws `RangeError: Maximum call stack size exceeded` on a large
 * collection. Real trigger: a Spotify library of 29,498 distinct songs is already within
 * the same order of magnitude as V8's limit.
 *
 * `floor` is returned when the iterable is empty, and doubles as the "at least this" guard
 * that callers were expressing with `Math.max(..., 1)`.
 */
export function maxOf(values: Iterable<number>, floor = Number.NEGATIVE_INFINITY): number {
    let max = floor;
    for (const v of values) {
        if (v > max) {
            max = v;
        }
    }

    return max;
}

/**
 * Compute cosine distance between two vectors.
 * Returns 0 for identical vectors, 2 for opposite vectors.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        throw new RangeError(`Vector lengths must match (got ${a.length} and ${b.length})`);
    }

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
