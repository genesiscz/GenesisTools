/**
 * Escaping, width measurement and truncation.
 *
 * 🛑 Order matters: truncate first, escape second. Escaping first and cutting afterwards can
 * land the cut between a backslash and the pipe it escapes, which leaves a trailing backslash
 * that escapes the column separator and merges two columns. That bug is live in
 * a downstream console table renderer today, and the tests pin that this module avoids it.
 */

import type { LineBreakStrategy, OverflowStrategy, StringLength } from "./types";

/**
 * The canonical `ansi-regex` pattern, built from a string rather than a regex literal.
 *
 * ⚠️ The order of the alternatives is load-bearing. A version whose first branch can match
 * the empty string strips only the `ESC[` prefix and leaves `31mred` behind, so a coloured
 * cell measures eight cells wide instead of three.
 *
 * It is assembled from a string because matching control characters is the whole point here:
 * ESC (U+001B), CSI (U+009B) and BEL (U+0007) are what an ANSI sequence is made of. A regex
 * literal containing them trips `lint/suspicious/noControlCharactersInRegex`, and suppressing
 * a rule that is right in general is worse than keeping the source free of control bytes.
 */
const ANSI_PATTERN =
    "[\\u001B\\u009B][[\\]()#;?]*" +
    "(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))";

const ANSI_RE = new RegExp(ANSI_PATTERN, "g");

/**
 * Code points that occupy no column: combining marks, joiners and variation selectors.
 * 🛑 Keep every range table in ascending order: `inRanges` is a binary search and silently
 * misses a range that sits out of place.
 */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x0300, 0x036f],
    [0x0483, 0x0489],
    [0x0591, 0x05bd],
    [0x0610, 0x061a],
    [0x064b, 0x065f],
    [0x0670, 0x0670],
    [0x06d6, 0x06dc],
    [0x0e31, 0x0e31],
    [0x0e34, 0x0e3a],
    [0x0e47, 0x0e4e],
    [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x20d0, 0x20f0],
    [0xfe00, 0xfe0f],
    [0xfe20, 0xfe2f],
    [0x1f3fb, 0x1f3ff],
    [0xe0100, 0xe01ef],
];

/** Code points that occupy two columns in a monospaced terminal or editor. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f],
    [0x2329, 0x232a],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xa960, 0xa97f],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x17000, 0x18aff],
    [0x1b000, 0x1b16f],
    [0x1f004, 0x1f004],
    [0x1f0cf, 0x1f0cf],
    [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a],
    [0x1f200, 0x1f320],
    [0x1f32d, 0x1f335],
    [0x1f337, 0x1f37c],
    [0x1f37e, 0x1f393],
    [0x1f3a0, 0x1f3ca],
    [0x1f3cf, 0x1f3d3],
    [0x1f3e0, 0x1f3f0],
    [0x1f3f4, 0x1f3f4],
    [0x1f3f8, 0x1f43e],
    [0x1f440, 0x1f440],
    [0x1f442, 0x1f4fc],
    [0x1f4ff, 0x1f53d],
    [0x1f54b, 0x1f54e],
    [0x1f550, 0x1f567],
    [0x1f57a, 0x1f57a],
    [0x1f595, 0x1f596],
    [0x1f5a4, 0x1f5a4],
    [0x1f5fb, 0x1f64f],
    [0x1f680, 0x1f6c5],
    [0x1f6cc, 0x1f6cc],
    [0x1f6d0, 0x1f6d2],
    [0x1f6eb, 0x1f6ec],
    [0x1f6f4, 0x1f6fc],
    [0x1f7e0, 0x1f7eb],
    [0x1f90c, 0x1f93a],
    [0x1f93c, 0x1f945],
    [0x1f947, 0x1f9ff],
    [0x1fa70, 0x1faff],
    [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
    let low = 0;
    let high = ranges.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const range = ranges[mid]!;

        if (code < range[0]) {
            high = mid - 1;
        } else if (code > range[1]) {
            low = mid + 1;
        } else {
            return true;
        }
    }

    return false;
}

/** Removes ANSI colour and cursor sequences so they do not count toward a column width. */
export function stripAnsi(value: string): string {
    return value.replace(ANSI_RE, "");
}

/**
 * Display width in terminal cells.
 *
 * This is the default `stringLength`. Pass your own to `TableOptions.stringLength` when a
 * renderer measures differently, which is the escape hatch both `markdown-table` and
 * `tablemark` arrived at independently.
 */
export function displayWidth(value: string): number {
    const plain = stripAnsi(value);
    let width = 0;

    for (const char of plain) {
        const code = char.codePointAt(0);

        if (code === undefined) {
            continue;
        }

        if (code === 0x200d) {
            // A zero-width joiner fuses the glyphs around it, so the sequence it builds is
            // one grapheme. Subtracting the width of the piece that follows keeps the total
            // at the width of a single emoji rather than the sum of its parts.
            width -= 2;
            continue;
        }

        if (inRanges(code, ZERO_WIDTH_RANGES)) {
            continue;
        }

        width += inRanges(code, WIDE_RANGES) ? 2 : 1;
    }

    return Math.max(0, width);
}

let segmenter: Intl.Segmenter | undefined;

/** Splits into user-perceived characters, so a cut never lands inside an emoji sequence. */
export function graphemes(value: string): string[] {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });

    return Array.from(segmenter.segment(value), (part) => part.segment);
}

export interface TruncateOptions {
    /** Budget in display cells, including the ellipsis. */
    max: number;
    strategy?: OverflowStrategy;
    stringLength?: StringLength;
    /** Default `…`, which is one cell wide. */
    ellipsis?: string;
}

/**
 * Cuts a string to a display-width budget on grapheme boundaries.
 *
 * `wrap` is not handled here, because wrapping produces several lines and a table cell can
 * hold only one. The table renderer turns `wrap` into a `<br>` join before calling this.
 */
export function truncateToWidth(value: string, options: TruncateOptions): string {
    const { max, strategy = "truncateEnd", stringLength = displayWidth, ellipsis = "…" } = options;

    if (max <= 0) {
        return "";
    }

    if (stringLength(value) <= max) {
        return value;
    }

    const marker = stringLength(ellipsis) <= max ? ellipsis : "";
    const budget = max - stringLength(marker);

    if (budget <= 0) {
        return marker.slice(0, max);
    }

    const parts = graphemes(value);

    if (strategy === "truncateStart") {
        const kept: string[] = [];
        let used = 0;

        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i]!;
            const size = stringLength(part);

            if (used + size > budget) {
                break;
            }

            kept.unshift(part);
            used += size;
        }

        return `${marker}${kept.join("")}`;
    }

    const kept: string[] = [];
    let used = 0;

    for (const part of parts) {
        const size = stringLength(part);

        if (used + size > budget) {
            break;
        }

        kept.push(part);
        used += size;
    }

    return `${kept.join("")}${marker}`;
}

/** Pads to a display width. Never truncates, so a long cell widens its column instead. */
export function padToWidth(
    value: string,
    width: number,
    align: "left" | "center" | "right",
    stringLength: StringLength = displayWidth
): string {
    const deficit = width - stringLength(value);

    if (deficit <= 0) {
        return value;
    }

    if (align === "right") {
        return `${" ".repeat(deficit)}${value}`;
    }

    if (align === "center") {
        const left = Math.floor(deficit / 2);

        return `${" ".repeat(left)}${value}${" ".repeat(deficit - left)}`;
    }

    return `${value}${" ".repeat(deficit)}`;
}

/**
 * Makes text safe inside one table cell.
 *
 * Only two characters can break a GitHub table: a `|` opens a column, and a line break opens
 * a row. Everything else is left alone, because a table cell renders inline markdown and
 * over-escaping would turn `**bold**` into literal asterisks.
 */
export function escapeCell(value: string, lineBreak: LineBreakStrategy = "strip"): string {
    const escaped = value.replace(/\|/g, "\\|");

    if (lineBreak === "preserve") {
        return escaped.replace(/\r\n|\r|\n/g, "<br>");
    }

    if (lineBreak === "truncate") {
        const firstBreak = escaped.search(/\r\n|\r|\n/);

        return firstBreak === -1 ? escaped : `${escaped.slice(0, firstBreak)}…`;
    }

    return escaped.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Characters that start a block or change meaning when they open a line — ANY line. Without
 * the `m` flag only the value's first line was escaped, so `"ok\n# Injected\n- item"` still
 * rendered a heading and a list: both can interrupt a paragraph. `[ \t]` rather than `\s`, so
 * the indent never swallows the newline and jumps a line. `~` covers a `~~~` fence.
 */
const BLOCK_STARTERS = /^([ \t]*)([#>\-+*=~]|\d+[.)])/gm;

/**
 * Escapes text that is about to sit in a paragraph, a list item, a heading or a table cell.
 *
 * Use this on any string that came from DATA rather than from a document author. Without it,
 * a value of `# Heading` becomes a heading, `<img onerror=…>` reaches the renderer as HTML,
 * and `[text](url)` becomes a link. That injection class is the single most-requested fix
 * across the JSON-to-Markdown libraries surveyed.
 *
 * Angle brackets and ampersands become HTML entities rather than backslash escapes, because
 * a backslash does not stop every renderer from treating `<script>` as a tag.
 */
export function escapeInline(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/([\\`*_[\]])/g, "\\$1")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(BLOCK_STARTERS, (_match, indent: string, marker: string) => `${indent}\\${marker}`);
}

/** Escapes a URL for `](...)`, where an unbalanced parenthesis or a space ends the link. */
export function escapeUrl(value: string): string {
    const trimmed = value.trim();

    if (/[()\s]/.test(trimmed)) {
        return `<${trimmed.replace(/[<>]/g, encodeURIComponent)}>`;
    }

    return trimmed;
}

/** Escapes the title argument in `[text](url "title")`. */
export function escapeLinkTitle(value: string): string {
    return value.replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}
