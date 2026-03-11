import { parse } from "comment-json";

type Reviver = (key: string | number, value: unknown) => unknown;

interface SafeParseOptions {
    /** Use native JSON.parse for strict validation (API boundaries, JSONL, etc.) */
    strict?: boolean;
}

/**
 * Drop-in replacement for the global JSON object, powered by comment-json.
 * parse: handles // comments, multi-line comments, trailing commas.
 *        Pass `{ strict: true }` as 3rd arg to use native JSON.parse instead.
 * stringify: uses native JSON.stringify — always produces standard JSON output.
 */
export const SafeJSON = {
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.parse return type for drop-in compatibility
    parse: (text: string, reviver?: Reviver | null, options?: SafeParseOptions): any => {
        if (options?.strict) {
            // biome-ignore lint/style/noRestrictedGlobals: intentional native JSON.parse for strict mode
            return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
        }

        return parse(text, reviver);
    },
    // biome-ignore lint/style/noRestrictedGlobals: stringify always uses native JSON for standard output
    stringify: JSON.stringify,
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
