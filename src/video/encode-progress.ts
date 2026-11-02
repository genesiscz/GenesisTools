import { basename } from "node:path";
import { progress as clackProgress } from "@clack/prompts";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { EncodeProgressEvent, EncodeRow } from "./encode";

export const ENCODE_FORMATS = ["text", "json", "jsonl"] as const;
export type EncodeFormat = (typeof ENCODE_FORMATS)[number];

export function isEncodeFormat(value: string): value is EncodeFormat {
    return ENCODE_FORMATS.some((format) => format === value);
}

/** Bar units per input; an input's share is its encode position (90%), then its decode check (the last 10%). */
const UNITS_PER_FILE = 1000;
const ENCODE_SHARE = 0.9;
/** A plain progress line without a terminal is written each time an input moves this much further. */
const PLAIN_STEP = 0.1;

export interface EncodeReporter {
    onProgress?: (event: EncodeProgressEvent) => void;
    onRow?: (row: EncodeRow) => void;
    stop(): void;
}

function percent(fraction: number | null): string {
    return fraction === null ? "?" : `${Math.floor(fraction * 100)}%`;
}

function describe(event: EncodeProgressEvent): string {
    const name = basename(event.input);

    if (event.phase === "verify") {
        return `${name}: checking that the result decodes`;
    }

    const pass = event.pass > 0 ? ` (size correction ${event.pass})` : "";
    const speed = event.speed === null ? "" : `, ${event.speed.toFixed(1)}x`;
    return `${name}: ${percent(event.fraction)}${speed}${pass}`;
}

/** The share of the whole bar an input has reached. A new size-correction pass starts its encode over. */
function unitsFor(event: EncodeProgressEvent): number {
    if (event.phase === "verify") {
        return ENCODE_SHARE * UNITS_PER_FILE;
    }

    return (event.fraction ?? 0) * ENCODE_SHARE * UNITS_PER_FILE;
}

function writeStderrLine(value: unknown): void {
    process.stderr.write(`${SafeJSON.stringify(value)}\n`);
}

/**
 * How `tools video encode` reports while it works. `jsonl` streams progress events and finished rows as lines on
 * stdout; `json` keeps stdout one document and writes progress lines on stderr; `text` shows a clack bar in a
 * terminal and a plain line per 10% elsewhere. Without `--progress` only rows are reported, as before.
 */
export function createEncodeReporter({
    format,
    progress,
    files,
}: {
    format: EncodeFormat;
    progress: boolean;
    files: number;
}): EncodeReporter {
    if (format === "jsonl") {
        return {
            onProgress: progress ? (event) => out.println(SafeJSON.stringify(event)) : undefined,
            onRow: (row) => out.println(SafeJSON.stringify({ type: "row", ...row })),
            stop: () => {},
        };
    }

    if (!progress) {
        return { stop: () => {} };
    }

    if (format === "json") {
        return { onProgress: writeStderrLine, stop: () => {} };
    }

    if (!process.stderr.isTTY) {
        const lastStep = new Map<string, number>();
        return {
            onProgress: (event) => {
                const step = event.phase === "verify" ? 10 : Math.floor((event.fraction ?? 0) / PLAIN_STEP);
                const key = `${event.input}:${event.pass}`;

                if (lastStep.get(key) !== step) {
                    lastStep.set(key, step);
                    process.stderr.write(`${describe(event)}\n`);
                }
            },
            stop: () => {},
        };
    }

    const bar = clackProgress({ max: Math.max(1, files) * UNITS_PER_FILE, style: "heavy" });
    const reached = new Map<string, number>();
    let shown = 0;
    let started = false;
    const moveTo = (message: string) => {
        const total = [...reached.values()].reduce((sum, units) => sum + units, 0);

        if (!started) {
            bar.start(message);
            started = true;
        }

        // The bar only moves forward: a size-correction pass restarts its input's share, so the bar waits until the
        // new pass passes the old position.
        bar.advance(Math.max(0, Math.floor(total) - shown), message);
        shown = Math.max(shown, Math.floor(total));
    };

    return {
        onProgress: (event) => {
            reached.set(event.input, Math.max(reached.get(event.input) ?? 0, unitsFor(event)));
            moveTo(describe(event));
        },
        onRow: (row) => {
            reached.set(row.input, UNITS_PER_FILE);
            moveTo(`${basename(row.input)}: ${row.status}`);
        },
        stop: () => {
            if (started) {
                bar.stop(`${files} file${files === 1 ? "" : "s"} done`);
            }
        },
    };
}
