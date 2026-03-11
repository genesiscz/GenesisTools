import { parse, stringify } from "comment-json";

type Reviver = (key: string | number, value: unknown) => unknown;

type ParseOptions = {
    jsonl?: boolean;
    reviver?: Reviver | null;
};

type StringifyOptions = {
    jsonl?: boolean;
};

/**
 * Drop-in replacement for the global JSON object, powered by comment-json.
 * parse: handles // comments, multi-line comments, trailing commas.
 *        Comments are preserved as Symbol-keyed properties on the result.
 *        Pass { jsonl: true } to use native JSON.parse for performance-critical JSONL processing.
 * stringify: produces standard JSON output with comments preserved.
 *            Pass { jsonl: true } to use native JSON.stringify.
 */
export const SafeJSON = {
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.parse return type for drop-in compatibility
    parse: (text: string, reviverOrOptions?: Reviver | ParseOptions | null): any => {
        // Check if second param is options object with jsonl flag
        if (reviverOrOptions && typeof reviverOrOptions === "object" && "jsonl" in reviverOrOptions) {
            const options = reviverOrOptions as ParseOptions;
            if (options.jsonl) {
                return JSON.parse(text, options.reviver);
            }
            return parse(text, options.reviver);
        }
        // Legacy: reviver function or null
        return parse(text, reviverOrOptions as Reviver | null);
    },
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.stringify parameter types
    stringify: (value: any, replacerOrOptions?: any, space?: string | number): string => {
        // Check if second param is options object with jsonl flag
        if (replacerOrOptions && typeof replacerOrOptions === "object" && "jsonl" in replacerOrOptions) {
            const options = replacerOrOptions as StringifyOptions;
            if (options.jsonl) {
                return JSON.stringify(value);
            }
        }
        // Default: use comment-json stringify with all params
        return stringify(value, replacerOrOptions, space);
    },
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