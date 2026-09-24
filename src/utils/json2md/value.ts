/**
 * Value lookup and display formatting.
 *
 * The rules here are the ones that cost other generators real bugs, so each one is stated
 * where it is enforced rather than left to the caller to remember.
 */

import type { HeaderCase } from "./types";

/**
 * Reads a dot path out of a value.
 *
 * Supports `a.b`, `a.0.b` and `a[0].b`. A missing link returns `undefined` rather than
 * throwing, because a heterogeneous row set is the normal case, not an error.
 */
export function getPath(source: unknown, path: string): unknown {
    if (path === "") {
        return source;
    }

    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let current = source;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }

        if (Array.isArray(current)) {
            const index = Number(part);

            if (!Number.isInteger(index)) {
                return undefined;
            }

            current = current[index];
            continue;
        }

        if (typeof current !== "object") {
            return undefined;
        }

        current = (current as Record<string, unknown>)[part];
    }

    return current;
}

export interface ScalarFormatOptions {
    /** Text for `null` and `undefined`. Default `""`. */
    empty?: string;
    /** Joins an array value. Default `", "`. */
    arraySeparator?: string;
    /** Number rendering. Default `plain`, which is `String(value)`. */
    numbers?: "plain" | "grouped" | ((value: number) => string);
    /** Date rendering. Default `iso-local`. */
    dates?: "iso" | "iso-local" | "date" | ((value: Date) => string);
    /** Renders a nested object or array of objects. Default `json`. */
    objects?: "json" | "keys" | ((value: object) => string);
}

/**
 * Groups thousands with a pinned locale.
 *
 * ⚠️ `en-US` is deliberate. The default locale on a Czech machine separates thousands with a
 * non-breaking space, which then sits inside a table cell and defeats a later grep.
 */
export function count(value: number): string {
    return value.toLocaleString("en-US");
}

export function percent(part: number, whole: number, digits = 2): string {
    if (whole === 0) {
        return "n/a";
    }

    return `${((part / whole) * 100).toFixed(digits)}%`;
}

/** Reads as the sentence it replaces: `114 of 24,590 claim sets (0.46%)`. */
export function ratioLine(part: number, whole: number, unit?: string): string {
    const suffix = unit ? ` ${unit}` : "";

    return `${count(part)} of ${count(whole)}${suffix} (${percent(part, whole)})`;
}

/**
 * An ISO-shaped timestamp in local time, to the minute.
 *
 * ⚠️ `toISOString()` is UTC. Using it for a generated-at header puts every document two
 * hours behind local time here, which went unnoticed for a week downstream.
 */
export function localTimestamp(date: Date = new Date()): string {
    return date.toLocaleString("sv-SE").slice(0, 16);
}

function formatDate(value: Date, mode: ScalarFormatOptions["dates"]): string {
    if (typeof mode === "function") {
        return mode(value);
    }

    if (mode === "iso") {
        return value.toISOString();
    }

    if (mode === "date") {
        return value.toLocaleDateString("sv-SE");
    }

    return localTimestamp(value);
}

/**
 * Turns any value into display text.
 *
 * 🛑 `null` and `undefined` become the empty text, but `0` and `false` survive. A
 * `value || ""` fallback loses both, and that silently blanks every zero in a report.
 */
export function formatScalar(value: unknown, options: ScalarFormatOptions = {}): string {
    const { empty = "", arraySeparator = ", ", numbers = "plain", dates = "iso-local", objects = "json" } = options;

    if (value === null || value === undefined) {
        return empty;
    }

    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number") {
        if (typeof numbers === "function") {
            return numbers(value);
        }

        if (!Number.isFinite(value)) {
            return String(value);
        }

        return numbers === "grouped" ? count(value) : String(value);
    }

    if (typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }

    if (value instanceof Date) {
        return formatDate(value, dates);
    }

    if (Array.isArray(value)) {
        return value.map((item) => formatScalar(item, options)).join(arraySeparator);
    }

    if (typeof value === "object") {
        if (typeof objects === "function") {
            return objects(value);
        }

        if (objects === "keys") {
            return Object.keys(value).join(arraySeparator);
        }

        return stableStringify(value);
    }

    return String(value);
}

/**
 * Compact JSON with stable key order.
 *
 * Key order stability matters because an unstable order makes every regenerated document a
 * diff, which trains reviewers to ignore the diff.
 */
export function stableStringify(value: unknown): string {
    const seen = new WeakSet<object>();

    const walk = (input: unknown): string => {
        if (input === null || input === undefined) {
            return "null";
        }

        if (typeof input === "string") {
            return quoteJsonString(input);
        }

        if (typeof input === "number") {
            return Number.isFinite(input) ? String(input) : "null";
        }

        if (typeof input === "boolean") {
            return String(input);
        }

        if (typeof input === "bigint") {
            return `"${input}"`;
        }

        if (input instanceof Date) {
            return quoteJsonString(input.toISOString());
        }

        if (Array.isArray(input)) {
            return `[${input.map(walk).join(",")}]`;
        }

        if (typeof input === "object") {
            if (seen.has(input)) {
                return '"[Circular]"';
            }

            seen.add(input);
            const entries = Object.keys(input as Record<string, unknown>)
                .sort()
                .map((key) => `${quoteJsonString(key)}:${walk((input as Record<string, unknown>)[key])}`);
            seen.delete(input);

            return `{${entries.join(",")}}`;
        }

        return "null";
    };

    return walk(value);
}

function quoteJsonString(value: string): string {
    let out = '"';

    for (const char of value) {
        const code = char.codePointAt(0)!;

        if (char === '"') {
            out += '\\"';
        } else if (char === "\\") {
            out += "\\\\";
        } else if (char === "\n") {
            out += "\\n";
        } else if (char === "\r") {
            out += "\\r";
        } else if (char === "\t") {
            out += "\\t";
        } else if (code < 0x20) {
            out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
            out += char;
        }
    }

    return `${out}"`;
}

/** Splits an identifier into words, handling camel, snake, kebab, dot and path forms. */
export function splitWords(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[\s_\-./\\]+/)
        .filter((word) => word.length > 0);
}

function upperFirst(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Words that stay lowercase inside a title, unless they lead it. */
const TITLE_MINOR = new Set([
    "a",
    "an",
    "and",
    "as",
    "at",
    "but",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "vs",
]);

/** Applies one of the 12 header casings to a column key. */
export function applyHeaderCase(key: string, style: HeaderCase = "preserve"): string {
    if (style === "preserve") {
        return key;
    }

    const words = splitWords(key);

    if (words.length === 0) {
        return key;
    }

    const lower = words.map((word) => word.toLowerCase());

    switch (style) {
        case "camelCase":
            return lower.map((word, index) => (index === 0 ? word : upperFirst(word))).join("");
        case "pascalCase":
            return lower.map(upperFirst).join("");
        case "constantCase":
            return lower.join("_").toUpperCase();
        case "dotCase":
            return lower.join(".");
        case "kebabCase":
            return lower.join("-");
        case "snakeCase":
            return lower.join("_");
        case "pathCase":
            return lower.join("/");
        case "trainCase":
            return lower.map(upperFirst).join("-");
        case "noCase":
            return lower.join(" ");
        case "sentenceCase":
            return upperFirst(lower.join(" "));
        case "capitalCase":
            return lower.map(upperFirst).join(" ");
        case "titleCase":
            return lower.map((word, index) => (index > 0 && TITLE_MINOR.has(word) ? word : upperFirst(word))).join(" ");
        default:
            return key;
    }
}
