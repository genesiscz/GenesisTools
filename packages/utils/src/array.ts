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
