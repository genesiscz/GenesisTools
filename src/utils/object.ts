/**
 * Shared object utilities for CLI tools.
 */

/**
 * Type guard: returns true if `value` is a plain object (not null, not an array).
 */
export function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep merge `source` into `target`. Only merges plain objects recursively;
 * arrays and primitives are overwritten.
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
    const result = { ...target };
    for (const key in source) {
        if (source[key] && isObject(source[key]) && isObject(result[key])) {
            (result as Record<string, unknown>)[key] = deepMerge(
                result[key] as Record<string, unknown>,
                source[key] as Record<string, unknown>,
            );
        } else if (source[key] !== undefined) {
            (result as Record<string, unknown>)[key] = source[key];
        }
    }
    return result;
}
