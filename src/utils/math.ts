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

/** The middle value (the mean of the two middle ones for an even count); undefined for none. */
export function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Intervals sorted once by their start, for repeated "which intervals hold this point" questions.
 *
 * A query finds the last interval that starts in time by binary search and walks back only while some earlier interval
 * still reaches the point, so a long list answers each point from its neighbourhood instead of a full scan. Results keep
 * the order of the input list, so "the last match" and "the first match" mean what they meant for a linear scan.
 */
export class IntervalIndex<T> {
    private readonly order: number[];
    private readonly starts: number[];
    private readonly ends: number[];
    /** The furthest end of any interval at or before each sorted position. */
    private readonly reach: number[];

    constructor(
        readonly items: readonly T[],
        span: (item: T) => { from: number; to: number }
    ) {
        const spans = items.map(span);
        this.order = items.map((_item, index) => index).sort((a, b) => spans[a]!.from - spans[b]!.from || a - b);
        this.starts = this.order.map((index) => spans[index]!.from);
        this.ends = this.order.map((index) => spans[index]!.to);
        this.reach = [];
        for (const [position, end] of this.ends.entries()) {
            this.reach.push(Math.max(end, this.reach[position - 1] ?? Number.NEGATIVE_INFINITY));
        }
    }

    /** Intervals with `from <= point <= to`, in input order. */
    containing(point: number): T[] {
        return this.walk(this.firstStartAfter(point, true), (end) => end >= point);
    }

    /** Intervals with `from < to` and `end > from` against the open range `(from, to)`, in input order. */
    overlapping(from: number, to: number): T[] {
        return this.walk(this.firstStartAfter(to, false), (end) => end > from);
    }

    /** The first sorted position whose start is past `limit` (or at it, when `inclusive` is false). */
    private firstStartAfter(limit: number, inclusive: boolean): number {
        let low = 0;
        let high = this.starts.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            const start = this.starts[mid]!;
            if (inclusive ? start <= limit : start < limit) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        return low;
    }

    private walk(upper: number, reaches: (end: number) => boolean): T[] {
        const hits: number[] = [];
        for (let position = upper - 1; position >= 0 && reaches(this.reach[position]!); position--) {
            if (reaches(this.ends[position]!)) {
                hits.push(this.order[position]!);
            }
        }

        return hits.sort((a, b) => a - b).map((index) => this.items[index]!);
    }
}
