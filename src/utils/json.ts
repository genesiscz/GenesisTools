/**
 * Shared JSON utilities for CLI tools.
 */

/**
 * Safely parse a JSON string. Returns `fallback` (or null) on parse failure.
 */
export function parseJSON<T>(text: string, fallback?: T): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        if (fallback !== undefined) return fallback;
        return null;
    }
}
