import { parse, stringify } from "comment-json";

type Reviver = (key: string | number, value: unknown) => unknown;

/**
 * Drop-in replacement for the global JSON object, powered by comment-json.
 * parse: handles // comments, multi-line comments, trailing commas.
 *        Comments are preserved as Symbol-keyed properties on the result.
 * stringify: produces standard JSON output with comments preserved.
 */
export const SafeJSON = {
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.parse return type for drop-in compatibility
    parse: (text: string, reviver?: Reviver | null): any => parse(text, reviver),
    stringify,
} as const;

/**
 * Safely parse a JSON string with comment support.
 * Returns `fallback` (or null) on parse failure.
 */
export function parseJSON<T>(text: string, fallback?: T): T | null {
    try {
        return parse(text) as T;
    } catch {
        if (fallback !== undefined) {
            return fallback;
        }

        return null;
    }
}
