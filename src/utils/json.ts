import { parse, stringify } from "comment-json";

type Reviver = (key: string | number, value: unknown) => unknown;
type Replacer = (string | number)[] | ((key: string, value: unknown) => unknown) | null;

export interface SafeJSONParseOptions {
    /**
     * If true (default), throws on parse errors like native JSON.parse.
     * If false, returns undefined on parse errors instead of throwing.
     */
    failfast?: boolean;
    /**
     * Optional reviver function passed to comment-json parse.
     */
    reviver?: Reviver | null;
}

export interface SafeJSONStringifyOptions {
    /**
     * Replacer for filtering/transforming values during stringify.
     */
    replacer?: Replacer;
    /**
     * Indentation for pretty-printing (number of spaces or string).
     */
    space?: string | number;
}

/**
 * Drop-in replacement for the global JSON object, powered by comment-json.
 *
 * parse: handles // comments, multi-line comments, trailing commas.
 *        Comments are preserved as Symbol-keyed properties on the result.
 *        Options:
 *          - failfast (default: true): throw on parse errors vs return undefined
 *          - reviver: transform values during parsing
 *
 * stringify: produces standard JSON output with comments preserved.
 *        Options:
 *          - replacer: filter/transform values during stringify
 *          - space: indentation for pretty-printing
 *
 * Examples:
 *   SafeJSON.parse('{ "a": 1 // comment\n }')  // works with comments
 *   SafeJSON.parse('invalid', { failfast: false })  // returns undefined
 *   SafeJSON.stringify(obj, { space: 2 })  // pretty-print with 2 spaces
 */
export const SafeJSON = {
    // biome-ignore lint/suspicious/noExplicitAny: match native JSON.parse return type for drop-in compatibility
    parse: (text: string, optionsOrReviver?: SafeJSONParseOptions | Reviver | null): any => {
        // Backward compatibility: if second arg is a function, treat as reviver
        if (typeof optionsOrReviver === "function") {
            return parse(text, optionsOrReviver);
        }

        const options = optionsOrReviver || {};
        const { failfast = true, reviver = null } = options;

        if (failfast) {
            return parse(text, reviver);
        }

        try {
            return parse(text, reviver);
        } catch {
            return undefined;
        }
    },

    stringify: (
        value: unknown,
        replacerOrOptions?: Replacer | SafeJSONStringifyOptions,
        space?: string | number,
    ): string => {
        // Backward compatibility: if second arg is array/function/null, treat as replacer
        if (
            Array.isArray(replacerOrOptions) ||
            typeof replacerOrOptions === "function" ||
            replacerOrOptions === null
        ) {
            return stringify(value, replacerOrOptions as Replacer, space);
        }

        const options = replacerOrOptions || {};
        return stringify(value, options.replacer, options.space);
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