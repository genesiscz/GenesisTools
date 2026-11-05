/**
 * What the meeting OCR benches share: consecutive real frames of a meeting with their motion facts, the darwinkit
 * helper's CPU, and the line share one read keeps of another. The meeting is only read; its frames are copied into
 * the scratch folder, and no text leaves the bench process.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { foldText, textSimilarity } from "@genesiscz/utils/macos/ocr-boxes";
import { captureSync, listPsTable, parseCpuTime } from "@genesiscz/utils/process/ps";
import type { CapturedFrame } from "@genesiscz/utils/screen-recorder/types";
import { changePercent, motionBoxes, signatureOf } from "./motion";

export interface Row {
    file: string;
    displayId: number;
    changePercent?: number;
    reason?: string;
    lines: number;
}

export interface BenchFrame {
    path: string;
    displayId: number;
    frame: Omit<CapturedFrame, "path" | "atMs">;
}

export function flagValue(flag: string): string | undefined {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
}

export function readRows(meeting: string): Row[] {
    return readFileSync(join(meeting, "ocr.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            const row = SafeJSON.parse(line, { strict: true }) as Row & { text?: string };
            return {
                file: row.file,
                displayId: row.displayId,
                changePercent: row.changePercent,
                reason: row.reason,
                lines: (row.text ?? "").split("\n").filter((one) => one.trim().length > 0).length,
            };
        });
}

/** The meeting's rows of each display, in frame order. */
export function rowsByDisplay(meeting: string): Map<number, Row[]> {
    const byDisplay = new Map<number, Row[]>();

    for (const row of readRows(meeting)) {
        byDisplay.set(row.displayId, [...(byDisplay.get(row.displayId) ?? []), row]);
    }

    for (const [id, rows] of byDisplay) {
        byDisplay.set(
            id,
            [...rows].sort((a, b) => a.file.localeCompare(b.file))
        );
    }

    return byDisplay;
}

/**
 * `count` consecutive rows of each of `displays` (rows in frame order), from the middle, copied into `scratch`, as
 * frames with motion facts: `changePercent` from the row, the motion boxes computed against the frame before it with
 * the recorder's own algorithm (`motion.ts`).
 */
export async function consecutiveFrames(options: {
    meeting: string;
    scratch: string;
    count: number;
    displays: Row[][];
}): Promise<BenchFrame[][]> {
    mkdirSync(options.scratch, { recursive: true });
    const sequences: BenchFrame[][] = [];

    for (const ordered of options.displays) {
        const start = Math.max(0, Math.floor(ordered.length / 2) - Math.floor(options.count / 2));
        const picked = ordered.slice(start, start + options.count);
        const frames: BenchFrame[] = [];
        let previous: Awaited<ReturnType<typeof signatureOf>> | undefined;

        for (const [index, row] of picked.entries()) {
            const path = join(options.scratch, row.file.replace(/^frames\//, ""));

            // Scratch names repeat between meetings; refresh the bytes before measuring them.
            copyFileSync(join(options.meeting, row.file), path);

            const signature = await signatureOf(path);
            const reason = index === 0 ? "first" : (row.reason ?? "change");
            const comparable = previous && (reason === "change" || reason === "heartbeat");
            const computed = previous ? changePercent(signature, previous) : 100;
            frames.push({
                path,
                displayId: row.displayId,
                frame: {
                    changePercent: row.changePercent && row.changePercent > 0 ? row.changePercent : computed,
                    reason,
                    ...(comparable && previous
                        ? { motionBoxes: reason === "change" ? motionBoxes(signature, previous) : [] }
                        : {}),
                },
            });
            previous = signature;
        }

        sequences.push(frames);
    }

    return sequences;
}

/** The darwinkit helper this process started, found by its parent pid. */
export async function helperPid(): Promise<number | null> {
    const rows = await listPsTable();
    return (
        rows.find((row) => row.ppid === process.pid && /(?:^|[/\\])darwinkit(?:\s|$)/i.test(row.command))?.pid ?? null
    );
}

/** A process's CPU so far (`ps cputime`, 10 ms resolution). */
export function helperCpuMs(pid: number | null): number {
    return pid === null ? 0 : (parseCpuTime(captureSync("ps", ["-p", String(pid), "-o", "cputime="]).stdout) ?? 0);
}

export function ownCpuMs(): number {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000;
}

/** A read's lines, folded (case, diacritics, spacing), each once. */
export function lineSet(text: string): Set<string> {
    return new Set(
        text
            .split("\n")
            .map(foldText)
            .filter((line) => line.length > 0)
    );
}

/** A line the same up to Vision's small misreads ("Quick views", "OuIck VewS"): bigram similarity at least this. */
const SAME_LINE = 0.8;

/**
 * Whether two folded lines can reach `SAME_LINE` at all: the Dice similarity of their letter pairs is at most
 * 2 × min / (a + b) for pair counts a and b, so lines of very different length are skipped before the pair count.
 */
function couldMatch(a: string, b: string): boolean {
    const left = a.length - 1;
    const right = b.length - 1;
    return left > 0 && right > 0 && (2 * Math.min(left, right)) / (left + right) >= SAME_LINE;
}

/** The share of `want`'s lines that `got` holds, the same or nearly the same. */
export function keptShare(want: Set<string>, got: Set<string>): number {
    if (want.size === 0) {
        return 1;
    }

    const others = [...got];
    const kept = [...want].filter(
        (line) =>
            got.has(line) || others.some((other) => couldMatch(line, other) && textSimilarity(line, other) >= SAME_LINE)
    );
    return kept.length / want.size;
}
