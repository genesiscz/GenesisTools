/**
 * Shared array utilities.
 */

/**
 * Wrap a value in an array if it isn't already an array.
 * Returns empty array for null/undefined.
 */
export function wrapArray<T>(value: T | T[] | undefined | null): T[] {
    if (value == null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

/**
 * Split a list into fixed-size batches. The last batch may be short.
 *
 * This lives here rather than beside its first caller because it is a plain list operation
 * and nothing about it is specific to one domain. It was previously exported from
 * `process/ps.ts`, which re-exports it so existing callers keep working, and a second copy had
 * already appeared under `ai/compact/`.
 */
export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

/** Immutable index move. Invalid indexes return an unchanged copy. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        from >= list.length ||
        to < 0 ||
        to >= list.length ||
        from === to
    ) {
        return [...list];
    }

    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);

    return next;
}

/**
 * Intervals looked up by overlap without scanning all of them. Kept sorted by start; a lookup starts one longest
 * interval before the query, so it reads only the intervals near it. Overlap is strict on both ends, as for half-open
 * spans: `from < queryTo && to > queryFrom`.
 */
export class IntervalIndex<T> {
    private readonly items: Array<{ from: number; to: number; value: T }> = [];
    private sorted = true;
    private longest = 0;

    get size(): number {
        return this.items.length;
    }

    add(from: number, to: number, value: T): void {
        const last = this.items.at(-1);
        if (last && from < last.from) {
            this.sorted = false;
        }

        this.items.push({ from, to, value });
        this.longest = Math.max(this.longest, to - from);
    }

    overlapping(from: number, to: number): T[] {
        const items = this.items;
        if (!this.sorted) {
            items.sort((a, b) => a.from - b.from);
            this.sorted = true;
        }

        // An interval that starts before `from - longest` ends at or before `from`, so it cannot overlap.
        const floor = from - this.longest;
        let low = 0;
        let high = items.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (items[mid]!.from < floor) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        const found: T[] = [];
        for (let at = low; at < items.length && items[at]!.from < to; at++) {
            if (items[at]!.to > from) {
                found.push(items[at]!.value);
            }
        }

        return found;
    }
}
