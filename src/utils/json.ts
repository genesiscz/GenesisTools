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
 * Plain JSON goes to the native `JSON.parse`; only text it rejects (comments, trailing commas) goes to comment-json,
 * which then parses and preserves comments as before. comment-json alone cost about 10 times the CPU on comment-free
 * text (1,039 ms against 112 ms for 15,861 transcript lines, 2026-10-12), and returned `CommentArray`s, boxed
 * top-level primitives and a `"__proto__"` key turned into the object's prototype, none of which plain JSON needs.
 * A text that neither parser accepts throws comment-json's error, as before.
 */
function parseTolerant(text: string, reviver: Reviver | null | undefined, noComments?: boolean): unknown {
    // A reviver keeps the comment-json path: under the native parser, a reviver that throws would be retried there,
    // running its side effects twice and turning its error into whatever the second run returns.
    if (reviver) {
        return parse(text, reviver, noComments);
    }

    try {
        // biome-ignore lint/style/noRestrictedGlobals: the native parser is the fast path for plain JSON
        return JSON.parse(text);
    } catch {
        // Not plain JSON: comment-json either parses it (comments, trailing commas) or throws the error callers see.
        return parse(text, null, noComments);
    }
}

/**
 * Drop-in replacement for the global JSON object, powered by comment-json.
 * parse: handles // comments, multi-line comments, trailing commas.
 *        Plain JSON is parsed natively; text with comments keeps them as Symbol-keyed properties on the result.
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
            return parseTolerant(text, options.reviver, options.unbox);
        }
        // Legacy: reviver function or null
        return parseTolerant(text, typeof reviverOrOptions === "function" ? reviverOrOptions : null);
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
        return parseTolerant(text, null) as T;
    } catch {
        if (fallback !== undefined) {
            return fallback;
        }

        return null;
    }
}

/**
 * The JSON documents of a text that holds several back to back, as `glab api --paginate` and `gh api --paginate`
 * print one array per page with nothing between them (`[…][…]`). Each document is parsed strictly; a text with one
 * document gives one entry. Throws on malformed JSON, like `JSON.parse`.
 */
export function parseConcatenatedJson(text: string): unknown[] {
    const documents: unknown[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (depth === 0 && char !== "[" && char !== "{" && !/[ \t\r\n]/.test(char)) {
            // A single primitive is valid too; any text around completed documents must fail strict parsing.
            return [SafeJSON.parse(text, { strict: true })];
        }

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === "[" || char === "{") {
            if (depth === 0) {
                start = index;
            }

            depth++;
        } else if (char === "]" || char === "}") {
            depth--;
            if (depth === 0) {
                documents.push(SafeJSON.parse(text.slice(start, index + 1), { strict: true }));
            }
        }
    }

    if (depth !== 0 || documents.length === 0) {
        // Malformed or not an array or object at all: let the native parser name the problem.
        return [SafeJSON.parse(text, { strict: true })];
    }

    return documents;
}
