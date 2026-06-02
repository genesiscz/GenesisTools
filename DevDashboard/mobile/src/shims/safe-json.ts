// RN-safe SafeJSON shim. The repo's real `@app/utils/json` is backed by `comment-json`
// (pulls in `esprima`) which is unnecessary weight in a React Native bundle. The
// `@dd/contract` only ever calls SafeJSON in strict mode (`{ strict: true }`,
// which routes the real impl to native JSON) plus a single plain-object `stringify` — both
// behavior-identical to native JSON. This shim is aliased in place of `@app/utils/json`
// for the mobile app (see tsconfig.json + metro.config.js). It does NOT preserve comments;
// the contract never needs that.

type Reviver = (key: string | number, value: unknown) => unknown;

interface ParseOptions {
    jsonl?: boolean;
    strict?: boolean;
    unbox?: boolean;
    reviver?: Reviver | null;
}

interface StringifyOptions {
    jsonl?: boolean;
    strict?: boolean;
}

function isParseOptions(value: unknown): value is ParseOptions {
    return (
        typeof value === "object" &&
        value !== null &&
        ("jsonl" in value || "strict" in value || "unbox" in value || "reviver" in value)
    );
}

export const SafeJSON = {
    // Mirrors the real `@app/utils/json` signature (returns `any` for drop-in compatibility) so that
    // repo files reached via the contract's type-only re-exports type-check identically under the
    // mobile tsconfig. The contract itself always casts the result (`... as T`), so this loses nothing.
    // biome-ignore lint/suspicious/noExplicitAny: faithful drop-in for the real SafeJSON.parse
    parse: (text: string, reviverOrOptions?: Reviver | ParseOptions | null): any => {
        if (isParseOptions(reviverOrOptions)) {
            return JSON.parse(text, reviverOrOptions.reviver ?? undefined);
        }

        return JSON.parse(text, typeof reviverOrOptions === "function" ? reviverOrOptions : undefined);
    },
    stringify: (value: unknown, replacerOrOptions?: StringifyOptions | null, space?: string | number): string => {
        return JSON.stringify(value, null, space);
    },
} as const;
