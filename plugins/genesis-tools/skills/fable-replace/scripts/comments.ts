/**
 * fable-replace — COMMENT AND LINE SWEEPS on a single file's text.
 *
 * `scanComments` is a real tokenizer: it tracks '…', "…", `…` (with ${} nesting),
 * escapes, regex literals, and the two JSX tag shapes that look like operators
 * (`</Foo>`, `<Foo />`), so "//" inside a string or a regex is never mistaken for a
 * comment. That matters — a naive scanner corrupted 0.95% of a real 5252-file repo
 * before the regex/JSX handling was added.
 *
 * It does NOT model JSX text. A comment-shaped run inside rendered text
 * (`<p>/* note *\/</p>`, `<a>https://…</a>`) is scanned as a comment, because telling
 * `<` as a tag from `<` as a comparison needs a parser this dependency-free script does
 * not have. On .tsx/.jsx files keep the predicate narrow and read `--dry --diff`.
 *
 * Use `dropComments` when the COMMENT must go but code on the same line must stay.
 * Use `deleteLines` when the WHOLE line must go. Getting that pair the wrong way
 * round is the commonest mistake in a comment sweep.
 */

import { FableReplaceError, stateless } from "./internal";
import type { CommentSpan, DeleteLinesOp, DropCommentsOp, DropCommentsOptions, OpResult } from "./types";

export const scanComments = (src: string): CommentSpan[] => {
    const spans: CommentSpan[] = [];
    let i = 0;
    let line = 1;
    // stack of template-literal contexts: each entry is the ${}-depth inside that template
    const templateStack: number[] = [];
    const n = src.length;

    // Previous significant code character, and the identifier ending on it. This is
    // the only way to tell a regex literal `/re/` from a division `a / b`. Without
    // it a literal such as /[&<>"']/g reads as a string opener and desyncs the rest
    // of the file, which corrupted 0.95% of a real 5252-file repo before this fix.
    const REGEX_OK_AFTER = new Set([
        "return",
        "typeof",
        "instanceof",
        "in",
        "of",
        "new",
        "delete",
        "void",
        "throw",
        "case",
        "do",
        "else",
        "yield",
        "await",
    ]);
    let prevChar = "";
    let prevWord = "";
    let wordBroke = true;
    const noteChar = (ch: string): void => {
        if (/\s/.test(ch)) {
            wordBroke = true;
            return;
        }
        if (/[\w$]/.test(ch)) {
            prevWord = wordBroke || !/[\w$]/.test(prevChar) ? ch : prevWord + ch;
        } else {
            prevWord = "";
        }
        prevChar = ch;
        wordBroke = false;
    };
    /** A string, template or regex literal just closed, so a value ended here. */
    const noteValueEnd = (): void => {
        prevChar = ")";
        prevWord = "";
        wordBroke = false;
    };
    const regexAllowedHere = (): boolean => {
        if (prevChar === "") {
            return true;
        }
        // "<" means a JSX closing tag (</Foo>), not a regex.
        if (prevChar === ")" || prevChar === "]" || prevChar === "<") {
            return false;
        }
        if (/[\w$]/.test(prevChar)) {
            return REGEX_OK_AFTER.has(prevWord);
        }
        return true;
    };
    /** Consume a regex literal so its slashes and quotes never reach the comment checks. */
    const skipRegexLiteral = (): void => {
        i += 1;
        let inClass = false;
        while (i < n) {
            const ch = src[i];
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === "\n") {
                return;
            }
            if (ch === "[") {
                inClass = true;
            } else if (ch === "]") {
                inClass = false;
            } else if (ch === "/" && !inClass) {
                i += 1;
                while (i < n && /[a-z]/.test(src[i] ?? "")) {
                    i += 1;
                }
                noteValueEnd();
                return;
            }
            i += 1;
        }
    };

    const skipString = (quote: string): void => {
        i += 1; // past the opening quote
        while (i < n) {
            const c = src[i];
            if (c === "\\") {
                i += 2;
                continue;
            }
            if (c === "\n") {
                line += 1;
            }
            if (c === quote) {
                i += 1;
                return;
            }
            i += 1;
        }
    };

    while (i < n) {
        const c = src[i];
        const next = src[i + 1];

        if (c === "\n") {
            line += 1;
            i += 1;
            continue;
        }

        // inside a template literal body?
        if (templateStack.length > 0 && templateStack[templateStack.length - 1] === 0) {
            if (c === "\\") {
                i += 2;
                continue;
            }
            if (c === "`") {
                templateStack.pop();
                noteValueEnd();
                i += 1;
                continue;
            }
            if (c === "$" && next === "{") {
                templateStack[templateStack.length - 1] = 1; // entering an interpolation
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        // in code (top level, or inside a ${…} interpolation)
        if (templateStack.length > 0) {
            if (c === "{") {
                templateStack[templateStack.length - 1] += 1;
            } else if (c === "}") {
                templateStack[templateStack.length - 1] -= 1;
            }
        }

        if (c === '"' || c === "'") {
            skipString(c);
            noteValueEnd();
            continue;
        }
        if (c === "`") {
            templateStack.push(0);
            i += 1;
            continue;
        }
        // next === ">" is a JSX self-close (<Foo />), never a regex.
        if (c === "/" && next !== "/" && next !== "*" && next !== ">" && regexAllowedHere()) {
            skipRegexLiteral();
            continue;
        }
        if (c === "/" && next === "/") {
            const start = i;
            const startLine = line;
            let end = src.indexOf("\n", i);
            if (end === -1) {
                end = n;
            }
            spans.push({ start, end, text: src.slice(start, end), type: "line", line: startLine });
            i = end;
            continue;
        }
        if (c === "/" && next === "*") {
            const start = i;
            const startLine = line;
            let end = src.indexOf("*/", i + 2);
            end = end === -1 ? n : end + 2;
            line += (src.slice(start, end).match(/\n/g) ?? []).length;
            spans.push({ start, end, text: src.slice(start, end), type: "block", line: startLine });
            i = end;
            continue;
        }
        noteChar(c);
        i += 1;
    }
    return spans;
};

/**
 * Remove a set of spans from the source. When removing a span leaves its line(s)
 * as pure whitespace, the whole line (including the newline) is removed too — so
 * dropping a full-line comment doesn't leave a blank hole.
 */
/** Neighbours that never fuse with a token, so no separator is needed beside them. */
const NEVER_FUSES = /[()[\]{},;:]/;

export const removeSpans = (src: string, spans: Array<{ start: number; end: number }>): string => {
    let out = src;
    const sorted = [...spans].sort((a, b) => b.start - a.start);
    for (const span of sorted) {
        let { start, end } = span;
        const lineStart = out.lastIndexOf("\n", start - 1) + 1;
        let lineEnd = out.indexOf("\n", end);
        lineEnd = lineEnd === -1 ? out.length : lineEnd + 1;
        const remainder = out.slice(lineStart, start) + out.slice(end, lineEnd);
        if (remainder.trim() === "") {
            start = lineStart;
            end = lineEnd;
        } else if (out.slice(end, lineEnd).trim() === "") {
            // span ends the line (e.g. trailing comment) — eat the whitespace before it too
            while (start > lineStart && (out[start - 1] === " " || out[start - 1] === "\t")) {
                start -= 1;
            }
        }
        // An inline comment is lexical whitespace: `return/*legacy*/value` must not fuse
        // into `returnvalue`, and `x/*c*//y` must not become a line comment. One space stays
        // when both neighbours are non-blank, unless one is a bracket, a comma, a semicolon
        // or a colon. A whole-line or trailing removal has a line break on one side.
        const before = out[start - 1] ?? "";
        const after = out[end] ?? "";
        const glue =
            /\S/.test(before) && /\S/.test(after) && !NEVER_FUSES.test(before) && !NEVER_FUSES.test(after) ? " " : "";
        out = out.slice(0, start) + glue + out.slice(end);
    }
    return out;
};

/**
 * Drop comments matching a predicate — string-aware (never touches "//" inside
 * strings), and removes the whole line when the comment was alone on it.
 * Returns the new content and how many comments were dropped.
 */
export const dropComments = (
    src: string,
    options: DropCommentsOptions
): { content: string; dropped: number; lines: number[] } => {
    const scope = options.scope ?? "both";
    // "" is not a predicate: every text includes it. Treated as absent, so it can neither
    // select every comment on its own nor widen a regex it is combined with.
    const containing = options.containing === "" ? undefined : options.containing;
    const matching = options.matching === undefined ? undefined : stateless(options.matching);
    const targets = scanComments(src).filter((span) => {
        if (scope !== "both" && span.type !== scope) {
            return false;
        }
        if (containing !== undefined && !span.text.includes(containing)) {
            return false;
        }
        if (matching !== undefined && !matching.test(span.text)) {
            return false;
        }
        return containing !== undefined || matching !== undefined;
    });
    if (options.expect !== undefined && targets.length !== options.expect) {
        // The direct call used to ignore `expect` and remove whatever matched; only the op
        // form checked it. The contract lives here now, for both doors.
        const where = targets.length > 0 ? ` at line(s) ${targets.map((span) => span.line).join(", ")}` : "";
        throw new FableReplaceError(
            `dropComments: expected ${options.expect} comment(s), found ${targets.length}${where} — nothing removed`,
            1
        );
    }

    return { content: removeSpans(src, targets), dropped: targets.length, lines: targets.map((span) => span.line) };
};

export const deleteLines = (src: string, op: DeleteLinesOp): { content: string; removed: number; lines: number[] } => {
    const lines = src.split("\n");
    const kept: string[] = [];
    // "" is not a predicate: every line includes it, so OR-ed with a regex it deleted the
    // whole file and reported OK. Treated as absent.
    const containing = op.containing === "" ? undefined : op.containing;
    const matching = op.matching === undefined ? undefined : stateless(op.matching);
    const hitLines: number[] = [];
    for (const [idx, l] of lines.entries()) {
        const hit = (containing !== undefined && l.includes(containing)) || matching?.test(l);
        if (hit) {
            hitLines.push(idx + 1);
        } else {
            kept.push(l);
        }
    }
    if (op.expect !== undefined && hitLines.length !== op.expect) {
        // The direct call used to ignore `expect`; only the op form checked it. Same
        // contract as dropComments: enforced here, for both doors.
        const where = hitLines.length > 0 ? ` at line(s) ${hitLines.join(", ")}` : "";
        throw new FableReplaceError(
            `deleteLines: expected ${op.expect} line(s), found ${hitLines.length}${where} — nothing removed`,
            1
        );
    }

    return { content: kept.join("\n"), removed: hitLines.length, lines: hitLines };
};

export const applyDropComments = (content: string, op: DropCommentsOp): { content: string; result: OpResult } => {
    const desc = op.label ?? `dropComments ${op.containing ? `containing "${op.containing}"` : String(op.matching)}`;
    // An EMPTY `containing` is not a predicate: "".includes("") is true for every comment,
    // so it silently dropped all of them and reported OK. Same guard recon.ts uses.
    if ((op.containing === undefined || op.containing === "") && op.matching === undefined) {
        return {
            content,
            result: {
                status: "MISS",
                desc,
                reason: "dropComments needs a non-empty `containing` or a `matching` regex — refusing to drop ALL comments",
            },
        };
    }
    let outcome: { content: string; dropped: number; lines: number[] };
    try {
        outcome = dropComments(content, op);
    } catch (err) {
        // The shared function enforces `expect`; the op form reports it as a MISS.
        return {
            content,
            result: {
                status: op.optional ? "SKIP" : "MISS",
                desc,
                reason: err instanceof Error ? err.message : String(err),
            },
        };
    }
    const { content: next, dropped, lines } = outcome;
    if (dropped === 0) {
        return {
            content,
            result: { status: op.optional ? "SKIP" : "MISS", desc, reason: "no comment matched", found: 0 },
        };
    }
    return { content: next, result: { status: "OK", desc, found: dropped, expected: op.expect, lines } };
};

export const applyDeleteLines = (content: string, op: DeleteLinesOp): { content: string; result: OpResult } => {
    const desc = op.label ?? `deleteLines ${op.containing ? `containing "${op.containing}"` : String(op.matching)}`;
    // An empty `containing` matches every line: it used to wipe the file and report OK.
    if ((op.containing === undefined || op.containing === "") && op.matching === undefined) {
        return {
            content,
            result: {
                status: "MISS",
                desc,
                reason: "deleteLines needs a non-empty `containing` or a `matching` regex — refusing to delete EVERY line",
            },
        };
    }
    let outcome: { content: string; removed: number; lines: number[] };
    try {
        outcome = deleteLines(content, op);
    } catch (err) {
        // The shared function enforces `expect`; the op form reports it as a MISS.
        return {
            content,
            result: {
                status: op.optional ? "SKIP" : "MISS",
                desc,
                reason: err instanceof Error ? err.message : String(err),
            },
        };
    }
    const { content: next, removed, lines } = outcome;
    if (removed === 0) {
        return {
            content,
            result: { status: op.optional ? "SKIP" : "MISS", desc, reason: "no line matched", found: 0 },
        };
    }
    return { content: next, result: { status: "OK", desc, found: removed, expected: op.expect, lines } };
};
