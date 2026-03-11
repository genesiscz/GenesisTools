import JSON5 from "json5";

/**
 * Drop-in replacement for the global JSON object.
 * parse: powered by json5 — handles // comments, multi-line comments,
 *        trailing commas, unquoted keys, and other JSON5 features.
 * stringify: uses native JSON.stringify — always produces standard JSON output.
 */
export const SafeJSON = {
    parse: JSON5.parse,
    stringify: globalThis.JSON.stringify,
} as const;

/**
 * Safely parse a JSON/JSON5 string. Returns `fallback` (or null) on parse failure.
 */
export function parseJSON<T>(text: string, fallback?: T): T | null {
    try {
        return JSON5.parse(text) as T;
    } catch {
        if (fallback !== undefined) {
            return fallback;
        }

        return null;
    }
}
