import { parse, stringify } from "comment-json";

type Reviver = (key: string | number, value: unknown) => unknown;

type ParseOptions = {
    jsonl?: boolean;
    strict?: boolean;
    /** Skip comment preservation — avoids boxing primitives (Boolean{}, String{}, Number{}) while still supporting comment-tolerant parsing */
    unbox?: boolean;
    reviver?: Reviver | null;
};

type StringifyOptions = {
    jsonl?: boolean;
    strict?: boolean;
};

/**
 * Drop-in replacement for the global JSON object, powered by comment-json.
 * parse: handles // comments, multi-line comments, trailing commas.
 *        Comments are preserved as Symbol-keyed properties on the result.
 *        Pass { jsonl: true } or { strict: true } to use native JSON.parse (rejects comments).
 * stringify: produces standard JSON output with comments preserved.
 *            Pass { jsonl: true } or { strict: true } to use native JSON.stringify.
 */
export const SafeJSON = {
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.parse return type for drop-in compatibility
    parse: (text: string, reviverOrOptions?: Reviver | ParseOptions | null): any => {
        if (
            reviverOrOptions &&
            typeof reviverOrOptions === "object" &&
            ("jsonl" in reviverOrOptions ||
                "strict" in reviverOrOptions ||
                "unbox" in reviverOrOptions ||
                "reviver" in reviverOrOptions)
        ) {
            const options = reviverOrOptions as ParseOptions;

            if (options.jsonl || options.strict) {
                // biome-ignore lint/style/noRestrictedGlobals: intentional strict-mode fallback to native JSON.parse
                return JSON.parse(text, options.reviver ?? undefined);
            }

            // comment-json's 3rd arg `no_comments` skips primitive boxing at the source
            return parse(text, options.reviver, options.unbox);
        }
        // Legacy: reviver function or null
        return parse(text, typeof reviverOrOptions === "function" ? reviverOrOptions : null);
    },
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.stringify parameter types
    stringify: (value: any, replacerOrOptions?: any, space?: string | number): string => {
        if (
            replacerOrOptions &&
            typeof replacerOrOptions === "object" &&
            ("jsonl" in replacerOrOptions || "strict" in replacerOrOptions)
        ) {
            const options = replacerOrOptions as StringifyOptions;
            if (options.jsonl || options.strict) {
                // biome-ignore lint/style/noRestrictedGlobals: intentional strict-mode fallback to native JSON.stringify
                return JSON.stringify(value, null, space);
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
