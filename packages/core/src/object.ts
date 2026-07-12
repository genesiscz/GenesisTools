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
    for (const key of Object.keys(source)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            continue;
        }

        const sourceValue = (source as Record<string, unknown>)[key];
        const targetValue = (result as Record<string, unknown>)[key];

        if (sourceValue !== undefined && isObject(sourceValue) && isObject(targetValue)) {
            (result as Record<string, unknown>)[key] = deepMerge(
                targetValue as Record<string, unknown>,
                sourceValue as Record<string, unknown>
            );
        } else if (sourceValue !== undefined) {
            (result as Record<string, unknown>)[key] = sourceValue;
        }
    }
    return result;
}
