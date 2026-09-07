/**
 * fable-replace — private helpers shared by the other modules. Not part of the
 * story a sweep script needs; nothing here decides policy.
 */

import * as fs from "node:fs";
import type { LiteralOp, NthIndexOfParams, Op, RunReport } from "./types";

/**
 * Every failure `run()` / `rollback()` / `renameSymbolAcross()` raises. `code` mirrors
 * the CLI exit code: 1 = misses or a partial write (nothing, or not everything, landed);
 * 2 = pre-flight / spec; 3 = the sweep IS written, but the verify failed or stale prose
 * survived. Three is the one a reader must never mistake for one.
 *
 * `report` carries the same RunReport a successful `run()` returns, so a catch can read
 * `err.report.files` / `.written` / `.missCount` instead of parsing the message. It is
 * set on the MISS and stale-prose failures, where a report exists; a pre-flight refusal
 * happens before any file is planned, so there it stays undefined.
 */
export class FableReplaceError extends Error {
    readonly code: 1 | 2 | 3;

    readonly report?: RunReport;

    constructor(message: string, code: 1 | 2 | 3, report?: RunReport) {
        super(message);
        this.name = "FableReplaceError";
        this.code = code;
        this.report = report;
    }
}

/** 1-based line numbers where `needle` (string or RegExp) matches, capped, for MISS reasons. */
export const matchLines = ({
    content,
    needle,
    cap = 12,
}: {
    content: string;
    needle: string | RegExp;
    cap?: number;
}): string => {
    const lines: number[] = [];
    if (typeof needle === "string") {
        let idx = content.indexOf(needle);
        while (idx !== -1 && lines.length <= cap) {
            lines.push(content.slice(0, idx).split("\n").length);
            idx = content.indexOf(needle, idx + Math.max(1, needle.length));
        }
    } else {
        const rx = new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`);
        for (const m of content.matchAll(rx)) {
            lines.push(content.slice(0, m.index ?? 0).split("\n").length);
            if (lines.length > cap) {
                break;
            }
        }
    }
    const shown = lines.slice(0, cap).join(", ");
    return lines.length > cap ? `${shown}, …` : shown;
};

/**
 * A regex carrying `g` or `y` keeps `lastIndex` between `.test()` calls, so one
 * instance tested against many strings silently skips every other match. Every
 * predicate use goes through this stateless clone instead.
 */
export const stateless = (rx: RegExp): RegExp =>
    rx.global || rx.sticky ? new RegExp(rx.source, rx.flags.replace(/[gy]/g, "")) : rx;

export const preview = (s: string, max = 60): string => {
    const flat = s.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

export const countOccurrences = (haystack: string, needle: string): number => {
    if (needle.length === 0) {
        return 0;
    }
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count += 1;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
};

/** Offsets where `needle` STARTS a line (offset 0 or right after "\n"), non-overlapping. */
export const lineStartOffsets = (haystack: string, needle: string): number[] => {
    const offsets: number[] = [];
    if (needle.length === 0) {
        return offsets;
    }
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        if (idx === 0 || haystack[idx - 1] === "\n") {
            offsets.push(idx);
            idx = haystack.indexOf(needle, idx + needle.length);
        } else {
            idx = haystack.indexOf(needle, idx + 1);
        }
    }
    return offsets;
};

/**
 * The line ending the file already uses, so inserted lines match their neighbours.
 * A file holding any CRLF at all is treated as CRLF: splicing one LF line into a CRLF
 * file is what later shows up as phantom diff noise.
 */
export const dominantEol = (content: string): string => (content.includes("\r\n") ? "\r\n" : "\n");

/** Index of the 1-based n-th occurrence of `needle`, or -1. */
export const nthIndexOf = ({ haystack, needle, n }: NthIndexOfParams): number => {
    // Non-overlapping, the same walk `countOccurrences` does: "aa" in "aaaa" has two
    // occurrences, so the 2nd starts at 2, not 1. Advancing one character at a time
    // disagreed with the count `locateBlock` had just used to prove the anchor unique.
    let idx = -1;
    let from = 0;
    for (let i = 0; i < n; i += 1) {
        idx = haystack.indexOf(needle, from);
        if (idx === -1) {
            return -1;
        }
        from = idx + Math.max(1, needle.length);
    }
    return idx;
};

export const replaceAllLiteral = (haystack: string, needle: string, replacement: string): string =>
    haystack.split(needle).join(replacement);

export const replaceNLiteral = (haystack: string, needle: string, replacement: string, n: number): string => {
    // The offsets are collected against the ORIGINAL string, non-overlapping (the same
    // walk `countOccurrences` does), and spliced in from the END. Searching the MUTATED
    // string on each pass meant a replacement that CONTAINS the needle re-matched itself:
    // count=2 of "oldName" → "wrapper(oldName)" wrapped the first call site twice, never
    // touched the second, and still reported "OK ×2 of 2 declared".
    const offsets: number[] = [];
    let idx = haystack.indexOf(needle);
    while (idx !== -1 && offsets.length < n) {
        offsets.push(idx);
        idx = haystack.indexOf(needle, idx + needle.length);
    }

    let out = haystack;
    for (const at of offsets.reverse()) {
        out = out.slice(0, at) + replacement + out.slice(at + needle.length);
    }

    return out;
};

export const opDesc = (op: Op): string => {
    if (op.label) {
        return op.label;
    }
    switch (op.kind) {
        case "regex":
            return `regex ${String(op.find)}`;
        case "deleteBlock":
            return `deleteBlock "${preview(op.from, 40)}" → "${preview(op.to, 24)}"`;
        case "replaceBlock":
            return `replaceBlock "${preview(op.from, 40)}" → "${preview(op.to, 24)}"`;
        case "insertBefore":
        case "insertAfter":
        case "insertLinesBefore":
        case "insertLinesAfter":
            return `${op.kind} "${preview(op.anchor, 40)}"`;
        case "append":
            return `append "${preview(op.text, 40)}"`;
        default:
            return `replace "${preview((op as LiteralOp).find, 48)}"`;
    }
};

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A JavaScript identifier on its own. `\b` is a WORD boundary and `$` is not a word
 * character, so `\bfoo\b` also matched inside `$foo`, and `\b$foo\b` never matched a
 * declaration of `$foo`.
 */
export const identifierPattern = (name: string): string => `(?<![\\w$])${escapeRegex(name)}(?![\\w$])`;

export const COLORS = {
    ok: "\x1b[32m",
    miss: "\x1b[31m",
    skip: "\x1b[33m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
};

const useColor = process.stdout.isTTY === true;

export const paint = (code: string, s: string): string => (useColor ? `${code}${s}${COLORS.reset}` : s);

/**
 * Did `abs` change since the sweep read it? The whole file is read into memory at plan
 * time; writing without this check silently destroyed a concurrent write and still
 * reported OK. A file that vanished counts as changed.
 */
export const changedOnDisk = ({ abs, expected }: { abs: string; expected: string }): boolean => {
    if (!fs.existsSync(abs)) {
        return true;
    }

    return fs.readFileSync(abs, "utf8") !== expected;
};
