import { spawnSync } from "node:child_process";
import type { DiffConfig } from "../config";
import type { DiffCategory } from "./classify";
import type { ChangedFile } from "./collect";
import type { Palette } from "./theme";

const DIM = "\u001b[2m";
const UNDIM = "\u001b[22m";
/**
 * Ends a foreground colour, bold, italic and underline, and keeps the background. `bat` closes
 * every token with a full reset, which inside a band would end the band at the first token.
 */
const KEEP_BAND = "\u001b[22;23;24;39m";
const TAB = "    ";
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
    /** What the row is. The themed render builds from the fields below; `classic` prints `text`. */
    kind?: "added" | "removed" | "context";
    /** The line's own text, tabs expanded, without the marker. */
    content?: string;
    /** The NEW line number of an added or context row, the OLD one of a removed row. */
    number?: number;
    /** Code-point span of the changed words in `content`, when a removed and an added row pair up. */
    word?: [number, number];
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
export function renderPatch(patch: string, palette: Palette | null = null): RenderedPatch {
    const body: PatchLine[] = [];
    let lineNumber = 0;
    let oldNumber = 0;
    let added = 0;
    let removed = 0;
    let seenHunk = false;

    for (const line of patch.split("\n")) {
        if (line.startsWith("@@")) {
            const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);

            if (!header) {
                continue;
            }

            if (seenHunk) {
                body.push({ text: `${DIM}${" ".repeat(GUTTER)}  ...${OFF}`, changed: false, at: null });
            }

            seenHunk = true;
            oldNumber = Number(header[1]);
            lineNumber = Number(header[2]);
            continue;
        }

        if (!seenHunk) {
            continue;
        }

        const content = line.slice(1).replaceAll("\t", TAB);

        if (line.startsWith("+")) {
            body.push({
                text: `${gutter(String(lineNumber))} ${ADDED}+${line.slice(1)}${EOL}${OFF}`,
                changed: true,
                at: null,
                kind: "added",
                content,
                number: lineNumber,
            });
            lineNumber += 1;
            added += 1;
        } else if (line.startsWith("-")) {
            body.push({
                text: `${gutter("")} ${REMOVED}-${line.slice(1)}${EOL}${OFF}`,
                changed: true,
                at: null,
                kind: "removed",
                content,
                number: oldNumber,
            });
            oldNumber += 1;
            removed += 1;
        } else if (line.startsWith(" ")) {
            body.push({
                text: contextLine(lineNumber, palette ? content : line.slice(1)),
                changed: false,
                at: lineNumber,
                kind: "context",
                content,
                number: lineNumber,
            });
            oldNumber += 1;
            lineNumber += 1;
        }
    }

    if (palette) {
        pairWords(body);

        for (const line of body) {
            if (line.changed) {
                line.text = bandRow(line, palette, 0);
            }
        }
    }

    return { body, added, removed };
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Where a removed row and the added row that replaced it differ, as code-point spans of each.
 * The edges back off to a word boundary, so a highlight never starts inside an identifier. `null`
 * when the rows share less than 40% of their text: the band alone then says more than a highlight
 * across most of the row would.
 */
export function wordSpans(before: string, after: string): { before: [number, number]; after: [number, number] } | null {
    const left = Array.from(before);
    const right = Array.from(after);
    let prefix = 0;

    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
        prefix += 1;
    }

    let suffix = 0;

    while (
        suffix < left.length - prefix &&
        suffix < right.length - prefix &&
        left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const inWord = (characters: string[], at: number) => WORD_CHARACTER.test(characters[at] ?? "");

    while (prefix > 0 && inWord(left, prefix - 1) && (inWord(left, prefix) || inWord(right, prefix))) {
        prefix -= 1;
    }

    while (
        suffix > 0 &&
        inWord(left, left.length - suffix) &&
        (inWord(left, left.length - suffix - 1) || inWord(right, right.length - suffix - 1))
    ) {
        suffix -= 1;
    }

    if (prefix + suffix < 0.4 * Math.max(left.length, right.length)) {
        return null;
    }

    return { before: [prefix, left.length - suffix], after: [prefix, right.length - suffix] };
}

/**
 * Pairs each run of removed rows with the run of added rows right after it, first with first, the
 * way Claude Code's own diff does, and marks the changed words of every pair.
 */
function pairWords(body: PatchLine[]): void {
    for (let at = 0; at < body.length; at += 1) {
        if (body[at]?.kind !== "removed") {
            continue;
        }

        let end = at;

        while (body[end]?.kind === "removed") {
            end += 1;
        }

        let stop = end;

        while (body[stop]?.kind === "added") {
            stop += 1;
        }

        for (let pair = 0; pair < Math.min(end - at, stop - end); pair += 1) {
            const before = body[at + pair];
            const after = body[end + pair];
            const spans = before && after ? wordSpans(before.content ?? "", after.content ?? "") : null;

            if (!before || !after || !spans) {
                continue;
            }

            if (spans.before[1] > spans.before[0]) {
                before.word = spans.before;
            }

            if (spans.after[1] > spans.after[0]) {
                after.word = spans.after;
            }
        }

        at = stop - 1;
    }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the ANSI escape sequences it must skip
const ESCAPE_SEQUENCE = /\u001b\[[0-9;]*[A-Za-z]/y;

/** `text` with the brighter word band over the code-point span `[start, end)`, escape codes skipped. */
function paintWords(text: string, [start, end]: [number, number], word: string, band: string): string {
    let out = "";
    let visible = 0;
    let index = 0;

    while (index < text.length) {
        ESCAPE_SEQUENCE.lastIndex = index;
        const sequence = ESCAPE_SEQUENCE.exec(text);

        if (sequence) {
            out += sequence[0];
            index += sequence[0].length;
            continue;
        }

        if (visible === start) {
            out += word;
        }

        if (visible === end) {
            out += band;
        }

        const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
        out += character;
        index += character.length;
        visible += 1;
    }

    return visible === end ? out + band : out;
}

/** `bat` output made safe inside a band: no reset, no background of its own. */
function keepBand(painted: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rewrites ANSI resets inside a band
    const reset = /\u001b\[0?m/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: drops ANSI backgrounds inside a band
    const background = /\u001b\[(?:4[0-9]|10[0-7]|48;[0-9;]*)m/g;

    return painted.replace(reset, KEEP_BAND).replace(background, "");
}

/**
 * A changed row in a Claude theme: the band behind the whole row, the line number dim, the marker,
 * the content (syntax-coloured when `painted` is given), and spaces to `width` columns so the band
 * reaches the edge of the terminal. Claude Code's renderer drops `ESC[K`, so padding is the only fill.
 */
function bandRow(line: PatchLine, palette: Palette, width: number, painted?: string): string {
    const added = line.kind === "added";
    const band = added ? palette.added : palette.removed;
    const content = line.content ?? "";
    let shown = painted === undefined ? content : keepBand(painted);

    if (line.word) {
        shown = paintWords(shown, line.word, added ? palette.addedWord : palette.removedWord, band);
    }

    const number = String(line.number ?? "").padStart(GUTTER);
    const used = GUTTER + 2 + Bun.stringWidth(content);
    const fill = width > used ? " ".repeat(width - used) : "";

    return `${band}${DIM}${number}${UNDIM} ${added ? "+" : "-"}${shown}${fill}${OFF}`;
}

/**
 * Syntax colour for every row of one block, through ONE `bat` that reads the rows from stdin in
 * patch order. `--file-name` picks the syntax, so a removed row and a deleted file are coloured too,
 * which reading the file on disk could not do. Indexed like `body`; `[]` when `bat` is off or fails.
 */
function paintRows(path: string, body: PatchLine[], config: DiffConfig): Array<string | undefined> {
    if (config.highlight !== "bat") {
        return [];
    }

    const run = spawnSync(
        "bat",
        ["--color=always", "--style=plain", "--paging=never", "--wrap=never", `--file-name=${path}`, "-"],
        { input: `${body.map((line) => line.content ?? "").join("\n")}\n`, encoding: "utf8", maxBuffer: 16_000_000 }
    );

    if (run.status !== 0 || typeof run.stdout !== "string") {
        return [];
    }

    const rows = run.stdout.split("\n");

    return body.map((line, index) => (line.kind ? rows[index] : undefined));
}

/** The upgrades a themed block offers `assembleMessage`; see `DiffBlock.dress`. */
export function themedDress(body: PatchLine[], palette: Palette, path: string, config: DiffConfig): BlockDress {
    return {
        width: 0,
        paint: () => paintRows(path, body, config),
        row: (index, width, painted) => {
            const line = body[index];

            if (!line?.kind) {
                return line?.text ?? "";
            }

            if (line.kind === "context") {
                return contextLine(line.number ?? 0, painted === undefined ? (line.content ?? "") : painted);
            }

            return bandRow(line, palette, width, painted);
        },
    };
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
    /**
     * A Claude theme's two luxuries, bought after every changed line is placed: first the band to
     * full width, then syntax colour. A tight budget therefore keeps content and loses polish.
     */
    dress?: BlockDress;
}

export interface BlockDress {
    /** Columns a changed row's band fills, or 0 to end it at the text. Set once the terminal is known. */
    width: number;
    /** Syntax-coloured content per body row, one `bat` spawn. */
    paint: () => Array<string | undefined>;
    /** Body row `index` as printed, filled to `width` and coloured with `painted` when given. */
    row: (index: number, width: number, painted?: string) => string;
}

export function renderBlock(
    file: ChangedFile,
    patch: RenderedPatch,
    hadBefore: boolean,
    category: DiffCategory = "source",
    label = file.path
): DiffBlock {
    // "Added" only when there was genuinely no before state, so a whole-file render
    // never reads as though one command wrote every line.
    const verb = file.deleted ? "Deleted" : !hadBefore && file.untracked ? "Added" : "Updated";
    // The kind is named only when it is NOT plain source, so the common block is unchanged
    // and the one that is here on sufferance says why it is here.
    const kind = category === "source" ? "" : ` ${DIM}· ${category}${OFF}`;

    return {
        head: `${BOLD}${verb} ${label}${OFF} ${DIM}(+${patch.added} -${patch.removed})${OFF}${kind}`,
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
 * The ceiling is measured in UTF-8 BYTES (`Output too large (9.9KB)`), so the budget is charged
 * in bytes. `.length` counts UTF-16 units: `Č` is 2 bytes and a CJK glyph 3, so an accented
 * note used to pass the limit and then lose its tail to the harness.
 */
function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/**
 * Spends what the content left on the themed blocks: the full-width band of every kept changed
 * row first, across all blocks, then syntax colour, changed rows before context. Each upgrade is
 * taken only while it fits. Returns the budget left.
 */
function dressBlocks(blocks: DiffBlock[], kept: Set<number>[], tinted: Map<number, string>[], budget: number): number {
    let left = budget;

    blocks.forEach((block, index) => {
        const dress = block.dress;
        const held = kept[index];
        const marks = tinted[index];

        if (!dress || !held || !marks || dress.width <= 0) {
            return;
        }

        for (const at of [...held].sort((first, second) => first - second)) {
            const line = block.body[at];

            if (!line?.changed) {
                continue;
            }

            const next = dress.row(at, dress.width);
            const extra = utf8Bytes(next) - utf8Bytes(line.text);

            if (extra <= left) {
                marks.set(at, next);
                left -= extra;
            }
        }
    });

    blocks.forEach((block, index) => {
        const dress = block.dress;
        const held = kept[index];
        const marks = tinted[index];

        if (!dress || !held || !marks) {
            return;
        }

        const order = byImportance(block).filter((at) => held.has(at) && block.body[at]?.kind !== undefined);

        if (order.length === 0 || order.length * COLOUR_FLOOR > left) {
            return;
        }

        const painted = dress.paint();

        for (const at of order) {
            const shade = painted[at];
            const current = marks.get(at) ?? block.body[at]?.text;

            if (shade === undefined || current === undefined) {
                continue;
            }

            const next = dress.row(at, marks.has(at) && block.body[at]?.changed ? dress.width : 0, shade);
            const extra = utf8Bytes(next) - utf8Bytes(current);

            if (extra <= left) {
                marks.set(at, next);
                left -= extra;
            }
        }
    });

    return left;
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
    // The `\n\n` between blocks is charged too, so the limit holds exactly rather than nearly.
    const separators = 2 * Math.max(0, blocks.length - 1);
    const headers = blocks.reduce((total, block) => total + utf8Bytes(block.head) + 1, 0) + separators;
    const footers = blocks.length * (utf8Bytes(moreLines(9_999_999)) + 1);
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

            if (utf8Bytes(line.text) + 1 > left) {
                // One over-long line is skipped rather than ending the whole fitting. It used
                // to zero the budget, so a single 400-byte minified line cost every file
                // below it every line it had left.
                continue;
            }

            held.add(at);
            left -= utf8Bytes(line.text) + 1;
        }

        if (!pending) {
            break;
        }
    }

    left = dressBlocks(blocks, kept, tinted, left);

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
            const extra = utf8Bytes(next) - utf8Bytes(line.text);

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
