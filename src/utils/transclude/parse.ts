/**
 * The token grammar, pure and synchronous:
 *
 *     {{<kind> key="value" key='value' key=value}}
 *
 * Params are named and order-free. `key: "value"` and commas between params are accepted too; the
 * documented form is `key="value"` separated by spaces. Inside quotes only `\"`, `\'` and `\\` are
 * escapes, so a Windows path like `"C:\Users\a.ts"` needs no doubling. `\{{` writes a literal `{{`.
 * Nothing inside a fenced code block or an inline code span is a token.
 *
 * A token ALWAYS carries at least one `key=value` (or `key: value`) param, or is the mdBook
 * `{{#include …}}` form. Anything else stays text: a bare `{{name}}` is a prompt variable of
 * `src/utils/template.ts` (`renderPrompt`, used by the hub prompts), and `{{ user.name }}` is a template.
 *
 * The mdBook forms map onto `file` and `lines`: `{{#include path}}`, `{{#include path:10:20}}`,
 * `{{#include path:10}}`, `{{#include path::20}}`, `{{#include path:10:}}`, `{{#include path:anchor}}`.
 */

export interface TextSegment {
    type: "text";
    value: string;
}

export interface TokenSegment {
    type: "token";
    raw: string;
    start: number;
    end: number;
    kind: string;
    alias?: string;
    params: Record<string, string>;
    /** A syntax error. The token is reported as failed with this reason and never resolved. */
    error?: string;
    /** True when the token is the only thing on its line. */
    standalone: boolean;
}

export type Segment = TextSegment | TokenSegment;

const KIND = /^[A-Za-z][\w-]*/;
const KEY = /^[A-Za-z_][\w-]*/;
const FIRST_PARAM = /^[ \t]*[ \t,][ \t,]*[A-Za-z_][\w-]*[ \t]*[=:]/;
const INCLUDE = "#include";
const QUOTE_ESCAPES = new Set(['"', "'", "\\"]);

class SyntaxProblem extends Error {}

/** Splits a text into literal runs and tokens. Never throws: a bad token becomes a segment with `error`. */
export function parseTranscludeText(text: string): Segment[] {
    const segments: Segment[] = [];
    let literal = "";
    let i = 0;
    let fence: { char: string; length: number } | null = null;

    const flush = (): void => {
        if (literal) {
            segments.push({ type: "text", value: literal });
            literal = "";
        }
    };

    while (i < text.length) {
        const atLineStart = i === 0 || text[i - 1] === "\n";

        if (atLineStart) {
            const lineEnd = endOfLine(text, i);
            const line = text.slice(i, lineEnd);
            const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);

            if (fence) {
                if (
                    marker &&
                    marker[1][0] === fence.char &&
                    marker[1].length >= fence.length &&
                    !line.slice(marker[0].length).trim()
                ) {
                    fence = null;
                }

                literal += text.slice(i, lineEnd + 1);
                i = lineEnd + 1;
                continue;
            }

            if (marker) {
                fence = { char: marker[1][0], length: marker[1].length };
                literal += text.slice(i, lineEnd + 1);
                i = lineEnd + 1;
                continue;
            }
        }

        const char = text[i];

        if (char === "`") {
            const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
            const close = findBacktickRun(text, i + run.length, run.length);

            if (close === -1) {
                literal += run;
                i += run.length;
                continue;
            }

            literal += text.slice(i, close + run.length);
            i = close + run.length;
            continue;
        }

        if (char === "\\" && text.startsWith("{{", i + 1)) {
            literal += "{{";
            i += 3;
            continue;
        }

        if (char === "{" && text[i + 1] === "{") {
            const token = readToken(text, i);

            if (!token) {
                literal += "{{";
                i += 2;
                continue;
            }

            flush();
            segments.push(token);
            i = token.end;
            continue;
        }

        literal += char;
        i++;
    }

    flush();
    return segments;
}

/** True when the text holds at least one token (cheap enough to call before `transclude`). */
export function hasTransclusionTokens(text: string): boolean {
    return text.includes("{{") && parseTranscludeText(text).some((segment) => segment.type === "token");
}

function endOfLine(text: string, from: number): number {
    const index = text.indexOf("\n", from);
    return index === -1 ? text.length : index;
}

function findBacktickRun(text: string, from: number, length: number): number {
    const pattern = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, "g");
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    return match ? match.index : -1;
}

function isStandalone(text: string, start: number, end: number): boolean {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    return !text.slice(lineStart, start).trim() && !text.slice(end, endOfLine(text, end)).trim();
}

/** A token starting at `start` (which holds `{{`), or null when the braces are not a token at all. */
function readToken(text: string, start: number): TokenSegment | null {
    let i = start + 2;

    while (text[i] === " " || text[i] === "\t") {
        i++;
    }

    if (text.startsWith(INCLUDE, i) && /[\s}]/.test(text[i + INCLUDE.length] ?? "")) {
        return readInclude(text, start, i + INCLUDE.length);
    }

    const kind = KIND.exec(text.slice(i))?.[0];

    // The kind must be followed by a param (`{{lines path=…`); a bare `{{lines}}` is a prompt variable.
    if (!kind || !FIRST_PARAM.test(text.slice(i + kind.length, i + kind.length + 80))) {
        return null;
    }

    i += kind.length;
    const params: Record<string, string> = {};

    try {
        const end = readParams(text, i, params, kind);
        return token({ text, start, end, kind, params });
    } catch (error) {
        if (!(error instanceof SyntaxProblem)) {
            throw error;
        }

        const close = text.indexOf("}}", i);
        const lineEnd = endOfLine(text, start);
        const end = close !== -1 && close < lineEnd ? close + 2 : lineEnd;
        return token({ text, start, end, kind, params, error: error.message });
    }
}

function token({
    text,
    start,
    end,
    kind,
    params,
    alias,
    error,
}: {
    text: string;
    start: number;
    end: number;
    kind: string;
    params: Record<string, string>;
    alias?: string;
    error?: string;
}): TokenSegment {
    return {
        type: "token",
        raw: text.slice(start, end),
        start,
        end,
        kind,
        ...(alias ? { alias } : {}),
        params,
        ...(error ? { error } : {}),
        standalone: isStandalone(text, start, end),
    };
}

/** Reads `key=value` pairs up to `}}` and returns the index after it. Throws a SyntaxProblem. */
function readParams(text: string, from: number, params: Record<string, string>, kind: string): number {
    let i = from;

    for (;;) {
        while (text[i] === " " || text[i] === "\t" || text[i] === ",") {
            i++;
        }

        if (text.startsWith("}}", i)) {
            return i + 2;
        }

        if (i >= text.length || text[i] === "\n") {
            throw new SyntaxProblem(`unterminated {{${kind} …: missing }}`);
        }

        const key = KEY.exec(text.slice(i))?.[0];

        if (!key) {
            throw new SyntaxProblem(`expected a param name like path="…", found "${preview(text, i)}"`);
        }

        i += key.length;

        while (text[i] === " " || text[i] === "\t") {
            i++;
        }

        if (text[i] !== "=" && text[i] !== ":") {
            throw new SyntaxProblem(`expected = after "${key}" (write ${key}="value")`);
        }

        i++;

        while (text[i] === " " || text[i] === "\t") {
            i++;
        }

        const { value, next } = readValue(text, i, key);

        if (Object.hasOwn(params, key)) {
            throw new SyntaxProblem(`duplicate param "${key}"`);
        }

        params[key] = value;
        i = next;
    }
}

function readValue(text: string, from: number, key: string): { value: string; next: number } {
    const quote = text[from];

    if (quote === '"' || quote === "'") {
        let value = "";
        let i = from + 1;

        while (i < text.length && text[i] !== "\n") {
            const char = text[i];

            if (char === "\\" && QUOTE_ESCAPES.has(text[i + 1] ?? "")) {
                value += text[i + 1];
                i += 2;
                continue;
            }

            if (char === quote) {
                return { value, next: i + 1 };
            }

            value += char;
            i++;
        }

        throw new SyntaxProblem(`unterminated quote in ${key}=${quote}…`);
    }

    let i = from;

    while (i < text.length && !/[\s,]/.test(text[i]) && !text.startsWith("}}", i)) {
        i++;
    }

    if (i === from) {
        throw new SyntaxProblem(`empty value for "${key}"`);
    }

    return { value: text.slice(from, i), next: i };
}

function preview(text: string, at: number): string {
    return text.slice(at, Math.min(endOfLine(text, at), at + 16));
}

/** `{{#include <arg>}}`: the argument runs to `}}` on the same line and is split from the right. */
function readInclude(text: string, start: number, from: number): TokenSegment {
    const close = text.indexOf("}}", from);
    const lineEnd = endOfLine(text, start);

    if (close === -1 || close > lineEnd) {
        return token({
            text,
            start,
            end: lineEnd,
            kind: "file",
            alias: INCLUDE,
            params: {},
            error: "unterminated {{#include …: missing }}",
        });
    }

    const arg = unquote(text.slice(from, close).trim());
    const end = close + 2;

    if (!arg) {
        return token({ text, start, end, kind: "file", alias: INCLUDE, params: {}, error: "#include needs a path" });
    }

    const mapped = mapInclude(arg);
    return token({ text, start, end, kind: mapped.kind, alias: INCLUDE, params: mapped.params });
}

function unquote(value: string): string {
    const quoted = /^(["'])(.*)\1$/.exec(value);
    return quoted ? quoted[2] : value;
}

/** The mdBook suffixes: `:a:b`, `::b`, `:a:`, `:a`, `:anchor`. A drive letter (`C:\x`) is never one. */
export function mapInclude(arg: string): { kind: "file" | "lines"; params: Record<string, string> } {
    const twoPart = /^(.+?):(\d*):(\d*)$/.exec(arg);

    if (twoPart && (twoPart[2] || twoPart[3])) {
        const [, path, from, to] = twoPart;
        return { kind: "lines", params: { path, range: `${from || "1"}-${to}` } };
    }

    const onePart = /^(.+):(\d+)$/.exec(arg);

    if (onePart) {
        return { kind: "lines", params: { path: onePart[1], range: onePart[2] } };
    }

    const anchor = /^(.+):([A-Za-z_][\w-]*)$/.exec(arg);

    if (anchor && !/^[A-Za-z]$/.test(anchor[1])) {
        return { kind: "lines", params: { path: anchor[1], anchor: anchor[2] } };
    }

    return { kind: "file", params: { path: arg } };
}
