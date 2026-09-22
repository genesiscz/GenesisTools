import { spawnSync } from "node:child_process";
import type { DiffConfig } from "../config";
import type { DiffCategory } from "./classify";
import type { ChangedFile } from "./collect";

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const OFF = "\u001b[0m";
/** Clears to end of row using the active background, for a full-width bar. */
const EOL = "\u001b[K";
const ADDED = "\u001b[48;5;22m\u001b[38;5;151m";
const REMOVED = "\u001b[48;5;52m\u001b[38;5;210m";
const GUTTER = 6;

/**
 * One rendered body line, tagged so a byte budget can buy the CHANGES before the context.
 *
 * 🛑 Lines used to be handed out in patch order, and a unified diff OPENS with
 * `contextLines` context lines. Observed 2026-09-22 across 15 parity contracts, each a
 * four-line edit: every block printed two context lines (`{` and `because:`) and elided all
 * eight of its changed lines. The message named the right files and then said nothing about
 * any of them, at the full cost of fifteen diffs and fifteen `bat` spawns.
 *
 * TWO bugs made it two lines rather than five. The order was one. The other was that colour
 * was baked into every context line BEFORE the budget was applied, and bat costs a measured
 * median of 115 bytes a line on that file (minimum 22, maximum 747). Of 9000 bytes, 2693 went
 * to headers and 555 to reserved footers, so 5752 remained: 35 coloured context lines across
 * 15 files, and not one line of any actual change. Colour is now bought last and only if it
 * fits, so the same budget carries 55 changed lines.
 */
export interface PatchLine {
    /** The line as it prints with no syntax colour. */
    text: string;
    /** `true` for an added or removed line: the part a reader came for. */
    changed: boolean;
    /** A context line's absolute line number, which is how its colour is found later. */
    at: number | null;
}

export interface RenderedPatch {
    body: PatchLine[];
    added: number;
    removed: number;
}

/** The 1-based line span the patch's hunks touch, or `null` when it has none. */
export function hunkRange(patch: string): { from: number; to: number } | null {
    let from = Number.POSITIVE_INFINITY;
    let to = 0;

    for (const line of patch.split("\n")) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line);

        if (!header?.[1]) {
            continue;
        }

        const start = Number(header[1]);
        const count = header[2] === undefined ? 1 : Number(header[2]);

        from = Math.min(from, start);
        to = Math.max(to, start + Math.max(count, 1) - 1);
    }

    return to === 0 ? null : { from: Math.max(1, from), to };
}

/**
 * Highlights only the lines the patch touches, indexed by ABSOLUTE line number.
 *
 * It used to highlight the whole file. At most `maxLinesPerFile` (30) context lines are ever
 * shown, so on a 3000-line source that read, parsed and coloured the entire file and threw
 * away 99% of it, once per changed file, on the PostToolUse hot path. `--line-range` makes
 * the cost proportional to the hunk instead.
 */
/**
 * A unified diff's CONTEXT lines are the only ones that get syntax colour, so a patch without
 * any is a patch whose highlighting would be computed and then thrown away.
 */
export function hasContext(patch: string): boolean {
    return patch.split("\n").some((line) => line.startsWith(" "));
}

export function highlightRange(
    path: string,
    range: { from: number; to: number } | null,
    config: DiffConfig,
    patch = " "
): string[] {
    // 🛑 One `bat` spawn per changed file sits on the PostToolUse hot path. Measured
    // 2026-09-22 on a 15-file change that rewrote every line: 597 ms with highlighting
    // against 159 ms without, for BYTE-IDENTICAL output, because a full rewrite leaves no
    // context line to colour. Raising `maxFiles` made that 438 ms of waste scale with it.
    if (config.highlight !== "bat" || !range || !hasContext(patch)) {
        return [];
    }

    const run = spawnSync(
        "bat",
        [
            "--color=always",
            "--style=plain",
            "--paging=never",
            "--wrap=never",
            `--line-range=${range.from}:${range.to}`,
            "--",
            path,
        ],
        { encoding: "utf8", maxBuffer: 16_000_000 }
    );

    if (run.status !== 0 || typeof run.stdout !== "string") {
        return [];
    }

    // `--line-range` returns the slice, so index 0 is line `range.from`. The renderer looks
    // lines up by absolute number, so the slice is padded back to that offset.
    const lines = run.stdout.split("\n");
    const padded: string[] = new Array(range.from - 1).fill("");

    return padded.concat(lines);
}

function gutter(value: string): string {
    return `${DIM}${value.padStart(GUTTER)}${OFF}`;
}

/** A context line, plain or coloured. Rebuilt rather than patched, so colour can arrive late. */
function contextLine(at: number, content: string): string {
    return `${gutter(String(at))}  ${content}`;
}

/**
 * Added and removed lines are solid full-width bars: `ESC[K` fills to the end of the row
 * with the active background. Only CONTEXT lines get syntax colour, because a nested
 * reset inside highlighted text would terminate the bar early.
 *
 * The render is PLAIN. Colour is applied by `assembleMessage`, to the context lines that
 * survive the budget and to no others.
 */
export function renderPatch(patch: string): RenderedPatch {
    const body: PatchLine[] = [];
    let lineNumber = 0;
    let added = 0;
    let removed = 0;
    let seenHunk = false;

    for (const line of patch.split("\n")) {
        if (line.startsWith("@@")) {
            const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);

            if (!header) {
                continue;
            }

            if (seenHunk) {
                body.push({ text: `${DIM}${" ".repeat(GUTTER)}  ...${OFF}`, changed: false, at: null });
            }

            seenHunk = true;
            lineNumber = Number(header[1]);
            continue;
        }

        if (!seenHunk) {
            continue;
        }

        if (line.startsWith("+")) {
            body.push({
                text: `${gutter(String(lineNumber))} ${ADDED}+${line.slice(1)}${EOL}${OFF}`,
                changed: true,
                at: null,
            });
            lineNumber += 1;
            added += 1;
        } else if (line.startsWith("-")) {
            body.push({
                text: `${gutter("")} ${REMOVED}-${line.slice(1)}${EOL}${OFF}`,
                changed: true,
                at: null,
            });
            removed += 1;
        } else if (line.startsWith(" ")) {
            body.push({ text: contextLine(lineNumber, line.slice(1)), changed: false, at: lineNumber });
            lineNumber += 1;
        }
    }

    return { body, added, removed };
}

/** One file's rendered change, still separable so the message can be fitted to a budget. */
export interface DiffBlock {
    head: string;
    /** Every body line the patch produced. `assembleMessage` decides which ones print. */
    body: PatchLine[];
    /**
     * Syntax colour for this file's context lines, indexed by absolute line number.
     *
     * 🛑 It is a thunk because it costs a `bat` spawn, and the budget decides whether a single
     * context line will be printed at all. Measured 2026-09-22 at 15 files: the budget went
     * entirely to added and removed lines, so every one of those spawns was thrown away.
     */
    colour?: () => string[];
}

export function renderBlock(
    file: ChangedFile,
    patch: RenderedPatch,
    hadBefore: boolean,
    category: DiffCategory = "source"
): DiffBlock {
    // "Added" only when there was genuinely no before state, so a whole-file render
    // never reads as though one command wrote every line.
    const verb = file.deleted ? "Deleted" : !hadBefore && file.untracked ? "Added" : "Updated";
    // The kind is named only when it is NOT plain source, so the common block is unchanged
    // and the one that is here on sufferance says why it is here.
    const kind = category === "source" ? "" : ` ${DIM}· ${category}${OFF}`;

    return {
        head: `${BOLD}${verb} ${file.path}${OFF} ${DIM}(+${patch.added} -${patch.removed})${OFF}${kind}`,
        body: patch.body,
    };
}

/**
 * The FEWEST bytes `bat` adds to one line. Measured 2026-09-22 over 85 lines of three real
 * source files: minimum 22, median 45 to 136, mean about 155, maximum 747. The MINIMUM is the
 * right figure for a gate that must never refuse colour the budget could in fact have paid for.
 */
const COLOUR_FLOOR = 22;

function moreLines(count: number): string {
    return `${DIM}${" ".repeat(GUTTER)}  … ${count} more lines${OFF}`;
}

/** The order the budget spends in: every changed line first, then the context around them. */
function byImportance(block: DiffBlock): number[] {
    const changed: number[] = [];
    const rest: number[] = [];

    block.body.forEach((line, index) => {
        (line.changed ? changed : rest).push(index);
    });

    return changed.concat(rest);
}

/**
 * Joins the blocks into ONE message that fits `maxMessageBytes`.
 *
 * 🛑 Every HEADER is kept. Breaching the harness ceiling loses the tail silently, so the file
 * names and their counts are the part that must survive; the hunks are what gets traded away.
 *
 * 🛑 The budget buys ADDED and REMOVED lines FIRST, across every file, before one byte goes
 * to context. See `PatchLine` for what printing a diff in patch order actually produced.
 *
 * Lines are handed out ROUND ROBIN rather than first come first served. A 30-line refactor
 * listed first would otherwise spend the whole budget and leave a one-line change below it
 * with nothing, which is the same failure as the harness truncation, just ours.
 *
 * The elision footers are counted before anything is handed out, so the returned message is
 * under the budget rather than near it. Headers alone can exceed it only if `maxFiles` and the
 * path lengths conspire; the message is then headers only, which is still readable.
 */
export function assembleMessage(blocks: DiffBlock[], config: DiffConfig): string {
    const queues = blocks.map(byImportance);
    const kept: Set<number>[] = blocks.map(() => new Set());
    const tinted: Map<number, string>[] = blocks.map(() => new Map());
    const headers = blocks.reduce((total, block) => total + block.head.length + 1, 0);
    const footers = blocks.length * (moreLines(9_999_999).length + 1);
    let left = config.maxMessageBytes - headers - footers;

    for (let round = 0; left > 0; round += 1) {
        let pending = false;

        for (let index = 0; index < blocks.length; index += 1) {
            const at = queues[index]?.[round];

            if (at === undefined) {
                continue;
            }

            // Set even when the line is refused below, because it is what proves a queue is
            // not yet exhausted, and so what terminates the loop.
            pending = true;

            const held = kept[index];
            const line = blocks[index]?.body[at];

            if (!held || !line || held.size >= config.maxLinesPerFile) {
                continue;
            }

            if (line.text.length + 1 > left) {
                // One over-long line is skipped rather than ending the whole fitting. It used
                // to zero the budget, so a single 400-byte minified line cost every file
                // below it every line it had left.
                continue;
            }

            held.add(at);
            left -= line.text.length + 1;
        }

        if (!pending) {
            break;
        }
    }

    blocks.forEach((block, index) => {
        const held = kept[index];
        const marks = tinted[index];

        if (!held || !marks || !block.colour) {
            return;
        }

        const context = [...held].filter((at) => block.body[at]?.at !== null);

        if (context.length === 0 || context.length * COLOUR_FLOOR > left) {
            // Not even the cheapest possible colour fits the lines this block kept, so the
            // `bat` spawn would be refused line by line straight afterwards. Measured
            // 2026-09-22 at 15 files: 15 spawns, 201 ms, and byte-identical output.
            // Three PLAIN context lines carry more than one coloured one, so the budget is
            // right to have spent itself on content first.
            return;
        }

        const coloured = block.colour();

        for (const at of context) {
            const line = block.body[at];
            const absolute = line?.at;

            if (!line || absolute === null || absolute === undefined) {
                continue;
            }

            const paint = coloured[absolute - 1];

            if (paint === undefined) {
                continue;
            }

            const next = contextLine(absolute, paint);
            const extra = next.length - line.text.length;

            // Colour is a luxury: it is applied only while it still fits. Without this the
            // escape sequences it adds would push the message back over the ceiling.
            if (extra > left) {
                continue;
            }

            marks.set(at, next);
            left -= extra;
        }
    });

    return blocks
        .map((block, index) => {
            const held = kept[index];
            const shown = [...(held ?? [])]
                .sort((first, second) => first - second)
                .map((at) => tinted[index]?.get(at) ?? block.body[at]?.text ?? "");
            const elided = block.body.length - shown.length;

            return [block.head, ...shown, ...(elided > 0 ? [moreLines(elided)] : [])].join("\n");
        })
        .join("\n\n");
}
