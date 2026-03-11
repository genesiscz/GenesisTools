import JSON5 from "json5";

/**
 * Drop-in replacement for the global JSON object, powered by json5.
 * Handles // comments, multi-line comments, trailing commas,
 * unquoted keys, and other JSON5 features in parse input.
 */
export const SafeJSON: typeof JSON5 = JSON5;

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
