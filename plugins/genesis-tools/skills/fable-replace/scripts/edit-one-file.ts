/**
 * fable-replace — EDITING THE TEXT OF ONE FILE. Everything here is pure: string in,
 * string out, no filesystem.
 *
 * These are the ops you put in a FileEdit's `ops` array: literal (the workhorse),
 * regex, deleteBlock/replaceBlock, insertBefore/insertAfter, fuzzy. Every op is
 * VERIFIED — a literal op with the default `count: 1` requires the needle exactly
 * once, so a stale assumption is a loud MISS, never a silent no-op.
 *
 * Prefer literal over regex. Paste the exact current text, indentation included.
 */

import { applyDeleteLines, applyDropComments } from "./comments";
import {
    countOccurrences,
    dominantEol,
    escapeRegex,
    lineStartOffsets,
    matchLines,
    nthIndexOf,
    opDesc,
    preview,
    replaceAllLiteral,
    replaceNLiteral,
} from "./internal";
import type {
    AppendOp,
    DeleteBlockOp,
    DropJsdocParams,
    DropParams,
    FuzzyOp,
    InsertLinesOp,
    InsertOp,
    LiteralOp,
    LiteralSugarParams,
    NearestHintParams,
    Op,
    OpResult,
    RegexOp,
    ReplaceBlockOp,
} from "./types";

/** What the ops before this one did to the buffer, so a MISS can tell "re-run" from "consumed". */
interface BatchContext {
    original: string;
    producedBy?: { index: number; desc: string };
}

/** Splice `replacement` over `length` characters at each offset, from the end so offsets stay valid. */
const replaceAtOffsets = ({
    content,
    offsets,
    length,
    replacement,
}: {
    content: string;
    offsets: number[];
    length: number;
    replacement: string;
}): string => {
    let out = content;
    for (const at of [...offsets].reverse()) {
        out = out.slice(0, at) + replacement + out.slice(at + length);
    }
    return out;
};

const applyLiteral = (content: string, op: LiteralOp, batch?: BatchContext): { content: string; result: OpResult } => {
    const desc = opDesc(op);
    // `wholeLines` (what `<<< delete` compiles to) counts only occurrences that start a
    // line: "foo" inside "notfoo" used to match, report OK, and leave "not" behind.
    const atLineStarts = op.wholeLines === true ? lineStartOffsets(content, op.find) : null;
    const found = atLineStarts === null ? countOccurrences(content, op.find) : atLineStarts.length;
    const want = op.count ?? 1;

    if (op.find === op.replace) {
        return { content, result: { status: "MISS", desc, reason: "find === replace (no-op edit)", found } };
    }

    if (found === 0) {
        const midLine = atLineStarts === null ? 0 : countOccurrences(content, op.find);
        const where =
            midLine > 0
                ? `needle occurs ${midLine}× but never at the start of a line (a delete body must be whole lines).`
                : `needle not found. ${nearestHint({
                      content,
                      needle: op.find,
                      replacement: op.replace,
                      original: batch?.original,
                      producedBy: batch?.producedBy,
                  })}`;
        return { content, result: { status: op.optional ? "SKIP" : "MISS", desc, reason: where, found } };
    }

    if (want === "all") {
        return {
            content:
                atLineStarts === null
                    ? replaceAllLiteral(content, op.find, op.replace)
                    : replaceAtOffsets({
                          content,
                          offsets: atLineStarts,
                          length: op.find.length,
                          replacement: op.replace,
                      }),
            result: { status: "OK", desc, found, expected: want },
        };
    }

    if (found !== want) {
        const lines =
            atLineStarts === null
                ? matchLines({ content, needle: op.find })
                : atLineStarts.map((at) => content.slice(0, at).split("\n").length).join(", ");
        return {
            content,
            result: {
                status: op.optional ? "SKIP" : "MISS",
                desc,
                reason: `expected exactly ${want} occurrence(s), found ${found} at line(s) ${lines} — add surrounding context to disambiguate, or set count to ${found}`,
                found,
            },
        };
    }

    return {
        content:
            atLineStarts === null
                ? replaceNLiteral(content, op.find, op.replace, want)
                : replaceAtOffsets({
                      content,
                      offsets: atLineStarts.slice(0, want),
                      length: op.find.length,
                      replacement: op.replace,
                  }),
        result: { status: "OK", desc, found, expected: want },
    };
};

const applyRegex = (content: string, op: RegexOp): { content: string; result: OpResult } => {
    const desc = opDesc(op);
    const global = op.find.global ? op.find : new RegExp(op.find.source, `${op.find.flags}g`);
    const found = (content.match(global) ?? []).length;

    if (found === 0) {
        return {
            content,
            result: { status: op.optional ? "SKIP" : "MISS", desc, reason: "regex matched nothing", found },
        };
    }

    if (op.expect !== undefined && found !== op.expect) {
        return {
            content,
            result: {
                status: op.optional ? "SKIP" : "MISS",
                desc,
                reason: `expected ${op.expect} match(es), found ${found} at line(s) ${matchLines({ content, needle: op.find })}`,
                found,
            },
        };
    }

    const next =
        typeof op.replace === "string"
            ? content.replace(global, op.replace)
            : content.replace(global, op.replace as (substring: string, ...args: unknown[]) => string);

    return { content: next, result: { status: "OK", desc, found, expected: op.expect } };
};

/**
 * A block anchor written with LF against a CRLF file. The literal form is tried first, so
 * a mixed-ending file keeps matching exactly what it did; only an absent LF anchor is
 * retried in its CRLF spelling. `dropJsdocStarting` closes on the JSDoc terminator plus
 * "\n", which no CRLF file contains.
 */
const eolAnchor = (content: string, anchor: string): string => {
    if (content.includes(anchor) || !anchor.includes("\n") || anchor.includes("\r") || !content.includes("\r\n")) {
        return anchor;
    }

    return anchor.replace(/\n/g, "\r\n");
};

const locateBlock = (
    content: string,
    op: DeleteBlockOp | ReplaceBlockOp
): { start: number; end: number } | { error: string } => {
    const from = eolAnchor(content, op.from);
    const to = eolAnchor(content, op.to);
    if (op.occurrence === undefined) {
        // Acting on the FIRST of several matching anchors silently leaves the others
        // alone and still reports OK. Ambiguity is a MISS, like every other op.
        const fromCount = countOccurrences(content, from);
        if (fromCount > 1) {
            return {
                error: `"from" anchor occurs ${fromCount}× (lines ${matchLines({ content, needle: from })}); add context to make it unique, or set occurrence`,
            };
        }
    }
    const fromIdx = nthIndexOf({ haystack: content, needle: from, n: op.occurrence ?? 1 });
    if (fromIdx === -1) {
        return {
            error: `"from" anchor not found (occurrence ${op.occurrence ?? 1}). ${nearestHint({ content, needle: from })}`,
        };
    }
    const searchFrom = fromIdx + from.length;
    const toIdx = content.indexOf(to, searchFrom);
    if (toIdx === -1) {
        return { error: `"to" anchor not found after "from"` };
    }
    const start = op.keepFrom ? fromIdx + from.length : fromIdx;
    const end = op.keepTo ? toIdx : toIdx + to.length;
    return { start, end };
};

const applyBlock = (content: string, op: DeleteBlockOp | ReplaceBlockOp): { content: string; result: OpResult } => {
    const desc = opDesc(op);
    const loc = locateBlock(content, op);
    if ("error" in loc) {
        return { content, result: { status: op.optional ? "SKIP" : "MISS", desc, reason: loc.error } };
    }
    const substitute = op.kind === "replaceBlock" ? op.replace : "";
    return {
        content: content.slice(0, loc.start) + substitute + content.slice(loc.end),
        result: { status: "OK", desc },
    };
};

const applyInsert = (content: string, op: InsertOp): { content: string; result: OpResult } => {
    const desc = opDesc(op);
    const idx = nthIndexOf({ haystack: content, needle: op.anchor, n: op.occurrence ?? 1 });
    if (idx === -1) {
        return {
            content,
            result: {
                status: op.optional ? "SKIP" : "MISS",
                desc,
                reason: `anchor not found (occurrence ${op.occurrence ?? 1})`,
            },
        };
    }
    const at = op.kind === "insertBefore" ? idx : idx + op.anchor.length;
    return { content: content.slice(0, at) + op.text + content.slice(at), result: { status: "OK", desc } };
};

/**
 * Offset in `content` where `needle` starts once EVERY whitespace character is
 * removed from both sides, or -1. "two=2" finds "two = 2" and vice versa, which a
 * whitespace-run-tolerant regex cannot do (it needs at least one space on both sides).
 */
const squashedIndexOf = ({ content, needle }: { content: string; needle: string }): number => {
    const map: number[] = [];
    let squashed = "";
    for (let i = 0; i < content.length; i += 1) {
        if (!/\s/.test(content[i])) {
            squashed += content[i];
            map.push(i);
        }
    }
    const target = needle.replace(/\s+/g, "");
    if (target.length === 0) {
        return -1;
    }
    const at = squashed.indexOf(target);
    return at === -1 ? -1 : map[at];
};
/** 1-based line number of the line that contains offset `at`. */
const lineAt = (content: string, at: number): number => content.slice(0, at).split("\n").length;

/**
 * Why did a literal needle miss? Say something a reader can act on: the file
 * already holds the replacement, the needle matches once whitespace is ignored
 * (so it is an indentation problem, use `fuzzy`), or the needle's first line
 * exists at line N and the text diverges from line N+k. A bare "not found" made
 * agents guess; this points at the line to re-read.
 */
export const nearestHint = ({ content, needle, replacement, original, producedBy }: NearestHintParams): string => {
    if (replacement !== undefined && replacement.length > 0 && content.includes(replacement)) {
        if (original !== undefined && !original.includes(replacement)) {
            // The text is there because THIS batch put it there: an earlier op consumed the
            // needle. "Make it optional" would hide an ordering mistake, so it is not offered.
            const who =
                producedBy === undefined
                    ? "an earlier op in this batch"
                    : `op ${producedBy.index + 1} of this batch (${producedBy.desc})`;
            return `the REPLACEMENT is present only because ${who} produced it: that op consumed this needle before this one ran. This is not a re-run. Reorder or merge the two ops, or drop this one.`;
        }

        return "the REPLACEMENT is already in the file: this edit was probably applied before (make the op optional to allow re-runs).";
    }
    const noSpace = squashedIndexOf({ content, needle });
    if (noSpace !== -1) {
        return `matches when ALL whitespace is ignored (first at line ${lineAt(content, noSpace)}): the difference is spaces, tabs, indentation or line breaks. Copy the exact text, or use kind "fuzzy".`;
    }
    const noCase = squashedIndexOf({ content: content.toLowerCase(), needle: needle.toLowerCase() });
    if (noCase !== -1) {
        return `matches when case AND whitespace are ignored (first at line ${lineAt(content, noCase)}): the needle has a letter-case typo somewhere. Re-read that line.`;
    }
    const nfcAt = content.normalize("NFC").indexOf(needle.normalize("NFC"));
    if (nfcAt !== -1) {
        return `matches after Unicode normalization (line ${lineAt(content.normalize("NFC"), nfcAt)}): the file and the needle spell the same accented text with different code points (NFC vs NFD). Copy the text from the file itself, or use kind "fuzzy".`;
    }
    const needleLines = needle.split("\n");
    const firstLine = needleLines.find((l) => l.trim().length > 0)?.trim() ?? "";
    if (firstLine.length === 0) {
        return "the needle is blank.";
    }
    const contentLines = content.split("\n");
    const candidates = contentLines.map((l, i) => ({ i, l })).filter(({ l }) => l.includes(firstLine));
    if (candidates.length === 0) {
        const probe = firstLine.slice(0, Math.max(12, Math.floor(firstLine.length / 2)));
        const probeLower = probe.toLowerCase();
        const partial = contentLines.findIndex((l) => l.toLowerCase().includes(probeLower));
        return partial === -1
            ? "no line of the file contains the needle's first line. Re-read the file: the text is different, or it lives in another file."
            : `the needle's first line is not in the file, but line ${partial + 1} starts the same way: "${preview(contentLines[partial].trim(), 70)}". Re-read from there.`;
    }
    for (const { i } of candidates) {
        for (let k = 1; k < needleLines.length; k += 1) {
            const actual = contentLines[i + k];
            if (actual === undefined || actual.trim() !== needleLines[k].trim()) {
                return `first line found at line ${i + 1}, text diverges at line ${i + k + 1}: file has "${preview((actual ?? "<end of file>").trim(), 70)}", needle has "${preview(needleLines[k].trim(), 70)}".`;
            }
        }
    }
    return `the needle's first line is at line ${candidates[0].i + 1} but the exact text is not. Check trailing spaces and tabs.`;
};

const lineBounds = (content: string, at: number): { start: number; end: number } => {
    const start = content.lastIndexOf("\n", at - 1) + 1;
    const nl = content.indexOf("\n", at);
    return { start, end: nl === -1 ? content.length : nl };
};

/**
 * Every offset where `anchor` occurs. An anchor that starts with whitespace carries its
 * indentation on purpose, so it only counts where it begins a line: "    foo" must not
 * match inside "        foo", or a wrong indentation would land the insert anyway.
 */
const anchorOffsets = ({ content, anchor }: { content: string; anchor: string }): number[] => {
    const offsets: number[] = [];
    if (anchor === "") {
        return offsets;
    }

    let idx = content.indexOf(anchor);
    while (idx !== -1) {
        if (!/^\s/.test(anchor) || idx === 0 || content[idx - 1] === "\n") {
            offsets.push(idx);
        }
        idx = content.indexOf(anchor, idx + 1);
    }
    return offsets;
};

const applyInsertLines = (content: string, op: InsertLinesOp): { content: string; result: OpResult } => {
    const offsets = anchorOffsets({ content, anchor: op.anchor });
    const found = offsets.length;
    const raw = countOccurrences(content, op.anchor);
    const anchorLine = op.anchor.split("\n");
    const textLines = op.text.replace(/\n$/, "").split("\n");
    const repeatsAnchor =
        textLines[0] === anchorLine[anchorLine.length - 1] || textLines[textLines.length - 1] === anchorLine[0];
    const desc = repeatsAnchor
        ? `${opDesc(op)} ⚠ the inserted text starts or ends with the anchor line; before/after KEEP the anchor, so it will appear twice`
        : opDesc(op);
    if (found !== 1) {
        const reason =
            found === 0 && raw > 0
                ? `anchor occurs ${raw}× but never at the start of a line: its indentation is wrong. Re-read line ${matchLines({ content, needle: op.anchor })} and copy the leading whitespace exactly`
                : found === 0
                  ? `anchor not found. ${nearestHint({ content, needle: op.anchor })}`
                  : `anchor occurs ${found}× (lines ${matchLines({ content, needle: op.anchor })}), must be unique: add surrounding context`;
        return { content, result: { status: op.optional ? "SKIP" : "MISS", desc, reason, found } };
    }
    // `text` is inserted line for line. A trailing "\n" is a real blank line, because
    // that is what an agent means when it leaves an empty last line in a spec body
    // ("insert this block, then a gap"). Stripping it once made a helper land glued to
    // the next declaration.
    // Inserted lines take the file's own line ending. Hardcoding "\n" spliced a lone LF
    // line into an otherwise all-CRLF file, which every later diff then shows as noise.
    const eol = dominantEol(content);
    const text = op.text.replace(/\r?\n/g, eol);
    // A multi-line anchor starts on one line and ends on another: "before" goes above
    // the line where it STARTS, "after" goes below the line where it ENDS. Inserting
    // after the first line of a two-line anchor once nested a new object key inside
    // the previous one, and the result still parsed.
    const anchorAt = offsets[0];
    const { start } = lineBounds(content, anchorAt);
    const bounds = lineBounds(content, anchorAt + op.anchor.length - 1);
    // lineBounds stops before the "\n" but AFTER a "\r", so on a CRLF file inserting at
    // `end` would leave the anchor line ending in a bare "\r" and split the pair.
    const end = content[bounds.end - 1] === "\r" ? bounds.end - 1 : bounds.end;
    const next =
        op.kind === "insertLinesBefore"
            ? `${content.slice(0, start)}${text}${eol}${content.slice(start)}`
            : `${content.slice(0, end)}${eol}${text}${content.slice(end)}`;
    return { content: next, result: { status: "OK", desc, found, expected: 1 } };
};

const applyAppend = (content: string, op: AppendOp): { content: string; result: OpResult } => {
    const desc = opDesc(op);
    // Same rule as insertLines: the text is literal, it takes the file's line ending, and
    // the file ends with a newline.
    const eol = dominantEol(content);
    const body = op.text.replace(/\r?\n/g, eol);
    const text = body.endsWith(eol) ? body : `${body}${eol}`;
    const glue = content.length === 0 || content.endsWith("\n") ? "" : eol;
    return { content: `${content}${glue}${text}`, result: { status: "OK", desc } };
};

const applyFuzzy = (content: string, op: FuzzyOp): { content: string; result: OpResult } => {
    const desc = op.label ?? `fuzzy "${op.find.replace(/\s+/g, " ").slice(0, 48)}"`;
    const rx = fuzzyWhitespaceRegex(op.find);
    const found = (content.match(rx) ?? []).length;
    const want = op.count ?? 1;
    if (found === 0) {
        return {
            content,
            result: { status: op.optional ? "SKIP" : "MISS", desc, reason: "no whitespace-tolerant match", found },
        };
    }
    if (want !== "all" && found !== want) {
        return {
            content,
            result: { status: op.optional ? "SKIP" : "MISS", desc, reason: `expected ${want}, found ${found}`, found },
        };
    }
    return { content: content.replace(rx, () => op.replace), result: { status: "OK", desc, found } };
};

/**
 * Build a regex that matches `needle` treating every run of whitespace as "any
 * whitespace". Lets a literal op survive reindentation/reformatting drift:
 * pass `fuzzy: true` on a LiteralOp when an exact match keeps missing on
 * whitespace grounds only.
 */
export const fuzzyWhitespaceRegex = (needle: string): RegExp => {
    const parts = needle
        .split(/\s+/)
        .filter((p) => p.length > 0)
        .map(escapeRegex);
    return new RegExp(parts.join("\\s+"), "g");
};

/**
 * An empty needle is never a match: `indexOf("")` succeeds at every offset, so the offset
 * scan of a line insert never terminated, a same-line insert or a block landed at offset
 * 0 and reported OK, and an empty fuzzy or regex needle matched between every character
 * and wrote the replacement everywhere. The marker parser refuses these earlier; this
 * guards the JSON and script doors.
 */
const emptyNeedle = (op: Op): string | null => {
    switch (op.kind) {
        case "fuzzy":
            return op.find.trim() === "" ? "fuzzy needle is empty or whitespace-only" : null;
        case "regex":
            return op.find.source === "(?:)" ? "regex is empty: it would match between every character" : null;
        case "insertBefore":
        case "insertAfter":
        case "insertLinesBefore":
        case "insertLinesAfter":
            return op.anchor === "" ? "anchor is empty: the anchor must hold the line to anchor on" : null;
        case "deleteBlock":
        case "replaceBlock":
            if (op.from === "") {
                return '"from" anchor is empty';
            }

            return op.to === "" ? '"to" anchor is empty' : null;
        default:
            return null;
    }
};

/** Apply a list of ops to a string. Pure — no filesystem access. */
export const applyOps = (content: string, ops: Op[]): { content: string; results: OpResult[] } => {
    let current = content;
    const results: OpResult[] = [];
    let producedBy: BatchContext["producedBy"];
    for (const op of ops) {
        let outcome: { content: string; result: OpResult };
        const empty = emptyNeedle(op);
        if (empty !== null) {
            const optional = "optional" in op && op.optional === true;
            results.push({ status: optional ? "SKIP" : "MISS", desc: opDesc(op), reason: empty });
            continue;
        }

        switch (op.kind) {
            case "regex":
                outcome = applyRegex(current, op);
                break;
            case "deleteBlock":
            case "replaceBlock":
                outcome = applyBlock(current, op);
                break;
            case "insertBefore":
            case "insertAfter":
                outcome = applyInsert(current, op);
                break;
            case "insertLinesBefore":
            case "insertLinesAfter":
                outcome = applyInsertLines(current, op);
                break;
            case "append":
                outcome = applyAppend(current, op);
                break;
            case "dropComments":
                outcome = applyDropComments(current, op);
                break;
            case "deleteLines":
                outcome = applyDeleteLines(current, op);
                break;
            case "fuzzy":
                outcome = applyFuzzy(current, op);
                break;
            default: {
                // The script door: a misspelled kind is not a literal op.
                const kind = (op as { kind?: string }).kind;
                if (kind !== undefined && kind !== "replace") {
                    outcome = {
                        content: current,
                        result: { status: "MISS", desc: opDesc(op), reason: `unknown op kind "${kind}"` },
                    };
                    break;
                }

                outcome = applyLiteral(current, op as LiteralOp, { original: content, producedBy });
                break;
            }
        }
        if (outcome.result.status === "OK" && outcome.content !== current) {
            producedBy = { index: results.length, desc: outcome.result.desc };
        }

        current = outcome.content;
        results.push(outcome.result);
    }
    return { content: current, results };
};

/** Literal op with count:"all" — replace every occurrence in the file. */
export const all = ({ find, replace, label }: LiteralSugarParams): LiteralOp => ({
    find,
    replace,
    count: "all",
    label,
});

/** Literal op that is allowed to not match (idempotent re-runs, optional cleanups). */
export const maybe = ({ find, replace, label }: LiteralSugarParams): LiteralOp => ({
    find,
    replace,
    optional: true,
    label,
});

/** Delete an exact literal chunk (must occur exactly once). */
export const drop = ({ find, label }: DropParams): LiteralOp => ({
    find,
    replace: "",
    label: label ?? `drop "${preview(find, 44)}"`,
});

/**
 * Delete a whole /** … *\/ JSDoc (or any block) that STARTS with the given prefix.
 * Sugar over deleteBlock with the closing anchor defaulted to the end of a JSDoc
 * plus its trailing newline.
 */
export const dropJsdocStarting = ({ fromPrefix, label }: DropJsdocParams): DeleteBlockOp => ({
    kind: "deleteBlock",
    from: fromPrefix,
    to: " */\n",
    label: label ?? `dropJsdoc "${preview(fromPrefix, 40)}"`,
});
