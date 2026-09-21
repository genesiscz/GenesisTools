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

export interface RenderedPatch {
    body: string[];
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
export function highlightRange(path: string, range: { from: number; to: number } | null, config: DiffConfig): string[] {
    if (config.highlight !== "bat" || !range) {
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

/**
 * Added and removed lines are solid full-width bars: `ESC[K` fills to the end of the row
 * with the active background. Only CONTEXT lines get syntax colour, because a nested
 * reset inside highlighted text would terminate the bar early.
 */
export function renderPatch(patch: string, highlighted: string[], _config: DiffConfig): RenderedPatch {
    const body: string[] = [];
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
                body.push(`${DIM}${" ".repeat(GUTTER)}  ...${OFF}`);
            }

            seenHunk = true;
            lineNumber = Number(header[1]);
            continue;
        }

        if (!seenHunk) {
            continue;
        }

        if (line.startsWith("+")) {
            body.push(`${gutter(String(lineNumber))} ${ADDED}+${line.slice(1)}${EOL}${OFF}`);
            lineNumber += 1;
            added += 1;
        } else if (line.startsWith("-")) {
            body.push(`${gutter("")} ${REMOVED}-${line.slice(1)}${EOL}${OFF}`);
            removed += 1;
        } else if (line.startsWith(" ")) {
            body.push(`${gutter(String(lineNumber))}  ${highlighted[lineNumber - 1] ?? line.slice(1)}`);
            lineNumber += 1;
        }
    }

    return { body, added, removed };
}

export function renderBlock(
    file: ChangedFile,
    patch: RenderedPatch,
    hadBefore: boolean,
    config: DiffConfig,
    category: DiffCategory = "source"
): string {
    // "Added" only when there was genuinely no before state, so a whole-file render
    // never reads as though one command wrote every line.
    const verb = file.deleted ? "Deleted" : !hadBefore && file.untracked ? "Added" : "Updated";
    const shown = patch.body.slice(0, config.maxLinesPerFile);
    const elided = patch.body.length - shown.length;
    // The kind is named only when it is NOT plain source, so the common block is unchanged
    // and the one that is here on sufferance says why it is here.
    const kind = category === "source" ? "" : ` ${DIM}· ${category}${OFF}`;

    return [
        `${BOLD}${verb} ${file.path}${OFF} ${DIM}(+${patch.added} -${patch.removed})${OFF}${kind}`,
        ...shown,
        ...(elided > 0 ? [`${DIM}${" ".repeat(GUTTER)}  … ${elided} more lines${OFF}`] : []),
    ].join("\n");
}
