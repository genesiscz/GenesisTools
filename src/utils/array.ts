/**
 * Shared array utilities for CLI tools.
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
