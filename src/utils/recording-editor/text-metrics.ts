import type { TEXT_ALIGNS } from "./project";
import metrics from "./text-metrics.json";

/**
 * How the renderer sets a text (Captions.swift TextPlates.render: NSAttributedString.boundingRect in the semibold
 * system font), from that font's measured widths, kerning and line height in text-metrics.json, which
 * scripts/recorder/text-metrics.swift writes. RecorderTextMetricsTests checks the same estimate against the renderer.
 */
export interface TextLayout {
    /** The width of the box the lines are drawn in (boundingRect's), in pixels. */
    width: number;
    /** Every line's height together, in pixels. */
    height: number;
    lines: number;
}

const INDEX = new Map(Array.from(metrics.chars).map((char, index) => [char, index]));
const KERN_TEXT_PX = metrics.kerning.sizes[0];
const KERN_DISPLAY_PX = metrics.kerning.sizes[1];
/** The kerning at the two kerning sizes, by left class and right class (kernKey). */
const KERNING = new Map<number, [number, number]>();

for (const [left, row] of metrics.kerning.pairs.entries()) {
    for (let at = 0; at + 2 < row.length; at += 3) {
        KERNING.set(kernKey(left, row[at]), [row[at + 1], row[at + 2]]);
    }
}

function kernKey(left: number, right: number): number {
    return left * 4096 + right;
}

/** The widths (em) of the table's characters at one font size; the last one is for a character outside the table. */
const advancesAt = new Map<number, Float64Array>();

function advances(px: number): Float64Array {
    const known = advancesAt.get(px);

    if (known) {
        return known;
    }

    // Between two measured sizes a width is interpolated; below the first and above the last the nearest one holds.
    const { sizes } = metrics;
    const above = sizes.findIndex((size) => size >= px);
    const high = above === -1 ? sizes.length - 1 : above;
    const low = above > 0 && sizes[above] !== px ? above - 1 : high;
    const share = low === high ? 0 : (px - sizes[low]) / (sizes[high] - sizes[low]);
    const row = (index: number) => [...metrics.advances[index], metrics.fallback[index]];
    const [from, to] = [row(low), row(high)];
    const widths = Float64Array.from(from, (width, index) => (width + (to[index] - width) * share) / metrics.unit);
    advancesAt.set(px, widths);
    return widths;
}

/** The kerning (em) between two of the table's characters at a font size; none beside a character outside it. */
function kerning(left: number | undefined, right: number | undefined, px: number): number {
    if (left === undefined || right === undefined) {
        return 0;
    }

    const values = KERNING.get(kernKey(metrics.kerning.left[left], metrics.kerning.right[right]));

    if (!values) {
        return 0;
    }

    const share = Math.min(1, Math.max(0, (px - KERN_TEXT_PX) / (KERN_DISPLAY_PX - KERN_TEXT_PX)));
    return (values[0] + (values[1] - values[0]) * share) / metrics.unit;
}

/** One line's height at a font size: TextKit rounds the ascender, the descender and the leading each to a pixel. */
function lineHeightPx(px: number): number {
    return Math.round(metrics.ascender * px) + Math.round(metrics.descender * px) + Math.round(metrics.leading * px);
}

/** Spaces end a line and hang past its wrap (a no-break space is not one of them). */
const SPACES = new Set([" ", "\t", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006"]);
/** A line may break after these as well as after a space ("E-|mail", "and/|or", "Why?|Because"). */
const BREAKS_AFTER = new Set(["-", "/", "?", "!", "|", "}", "\u2010", "\u2013", "\u2014", "\u2026"]);
/** No line starts with these, even after a space: "word !" and "a )" stay whole. */
const NO_BREAK_BEFORE = new Set(["!", "?", ")", "]", "}", ",", ".", ":", ";", "/", "\u201d"]);
/** No line ends with these, even before a space: "( word" and "„ word" stay whole. */
const NO_BREAK_AFTER = new Set([
    "(",
    "[",
    "{",
    "\u00a1",
    "\u00ab",
    "\u00bf",
    "\u2018",
    "\u201a",
    "\u201c",
    "\u201e",
    "\u2039",
]);

/**
 * `text` set at `px` and wrapped at `wrapPx` pixels, as NSAttributedString.boundingRect with usesLineFragmentOrigin
 * does: "\n" starts a line, a line breaks at its last break that fits (after a space, a hyphen, a slash, a dash, ...),
 * and a word longer than a line breaks between two letters. The width is TextKit's box around the lines: each line is
 * aligned by its letters, and the spaces it ends with reach on past them.
 */
export function layoutText(
    text: string,
    px: number,
    wrapPx: number,
    align: (typeof TEXT_ALIGNS)[number] = "center"
): TextLayout {
    const widths = advances(px);
    const outside = widths.length - 1;
    const lines: Array<{ letters: number; spaces: number }> = [];

    for (const paragraph of text.normalize("NFC").split(/\r\n|[\n\r\u2028\u2029]/)) {
        const chars = Array.from(paragraph);
        const indices = chars.map((char) => INDEX.get(char));
        const advance = (at: number) => widths[indices[at] ?? outside] * px;
        const kern = (at: number) => kerning(indices[at - 1], indices[at], px) * px;
        const span = (from: number, to: number) => {
            let sum = 0;

            for (let at = from; at < to; at++) {
                sum += advance(at) + (at > from ? kern(at) : 0);
            }

            return sum;
        };
        // A line's letters end where its last one does (with its kerning to the space after it); its spaces follow.
        const close = (from: number, to: number) => {
            let last = to;

            while (last > from && SPACES.has(chars[last - 1] ?? "")) {
                last--;
            }

            const letters = span(from, last) + (last > from && last < to ? kern(last) : 0);
            lines.push({ letters, spaces: span(from, to) - letters });
        };
        let start = 0;
        let breakAt = -1;
        let before = -1;
        let width = 0;
        let opened = false;
        const mark = (at: number) => {
            if (breakAt !== at) {
                before = breakAt;
            }

            breakAt = at + 1;
        };

        for (const [at, char] of chars.entries()) {
            if (breakAt === at && NO_BREAK_BEFORE.has(char)) {
                breakAt = before;
            }

            // The character does not fit: the line ends at its last break, or before this character when it has none.
            while (!SPACES.has(char) && at > start && width + kern(at) + advance(at) > wrapPx + 1e-6) {
                const end = breakAt > start ? breakAt : at;
                close(start, end);
                start = end;
                breakAt = -1;
                before = -1;
                width = span(start, at);
            }

            width += advance(at) + (at > start ? kern(at) : 0);

            if (SPACES.has(char)) {
                if (!opened) {
                    mark(at);
                }
            } else {
                opened = NO_BREAK_AFTER.has(char);

                if (BREAKS_AFTER.has(char)) {
                    mark(at);
                }
            }
        }

        close(start, chars.length);
    }

    // TextKit's box runs from the leftmost line's start to the rightmost line's end, and is never wider than the wrap.
    let leftmost = Number.POSITIVE_INFINITY;
    let rightmost = Number.NEGATIVE_INFINITY;

    for (const { letters, spaces } of lines) {
        const left = align === "left" ? 0 : align === "right" ? wrapPx - letters : (wrapPx - letters) / 2;
        leftmost = Math.min(leftmost, left);
        rightmost = Math.max(rightmost, left + letters + spaces);
    }

    return {
        width: Math.min(wrapPx, Math.max(0, rightmost - leftmost)),
        height: lines.length * lineHeightPx(px),
        lines: lines.length,
    };
}
