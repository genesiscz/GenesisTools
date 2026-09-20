import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { defaultLogPath } from "./config";

export interface DecisionRecord {
    at: string;
    phase: "pre" | "post" | "guard" | "diag";
    harness: string;
    session?: string;
    toolUseId?: string;
    decision: string;
    reason: string;
    [key: string]: unknown;
}

/**
 * 🛑 This module and everything it reaches runs on the hot path of EVERY Bash call, so it
 * deliberately does NOT import `@genesiscz/utils/logger`. Measured 2026-09-20: importing the
 * pino facade costs 14.9 ms and `Storage` another 16.2 ms, against a whole-hook budget of
 * about 45 ms. Diagnostics go into the same JSONL as the decisions, which is also where a
 * reader is already looking.
 */
let diagPath = defaultLogPath();

export function setDiagLogPath(path: string): void {
    diagPath = path;
}

/**
 * The decision log can hold the command verbatim (see `logCommands`), so it is created mode
 * 0600 inside a 0700 directory rather than inheriting the umask's 0644/0755. A log that
 * pre-dates this code keeps whatever mode it was created with, so it is tightened once per
 * process — not per record, because a hook writes one or two records and then exits.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Log paths whose MODE has been checked in this process; the stat happens once. */
const tightened = new Set<string>();

/**
 * Bytes believed to be in each log, seeded from one `stat` and then tracked in memory.
 *
 * The size is checked on EVERY record, not once per process. A hook binary writes one or two
 * records and exits, so a per-process check was enough for it — but `logDecision` is exported
 * and a long-lived writer would then never rotate, however far past the cap it went. Counting
 * in memory keeps that exact without a `stat` per record.
 */
const sizes = new Map<string, number>();

/**
 * Rotate once past this many bytes, keeping ONE generation. The cap is settable
 * (`maxLogBytes`); this is the fallback for `hookDiag`, which has no config in hand.
 *
 * Append-only with no cap grows forever, and while `logCommands` is `"shadow"` — the shipped
 * default — every command is in there verbatim. `hooks gc` sweeps captures and never touched
 * this file.
 */
let maxBytes = 16_000_000;

export function setMaxLogBytes(bytes: number): void {
    maxBytes = bytes;
}

/** Renames the log to `<path>.1`, replacing any previous generation. */
function rotate(path: string): void {
    try {
        renameSync(path, `${path}.1`);
        sizes.set(path, 0);
    } catch {
        // A log that cannot be rotated keeps growing, which is better than losing the write.
    }
}

/** Current size, from the in-memory count, seeded from disk the first time. */
function sizeOf(path: string): number {
    const known = sizes.get(path);

    if (known !== undefined) {
        return known;
    }

    let seeded = 0;

    try {
        seeded = statSync(path).size;
    } catch {
        // No log yet; `appendFileSync` creates it with the right mode.
    }

    sizes.set(path, seeded);

    return seeded;
}

function append(path: string, record: Record<string, unknown>): void {
    try {
        const dir = dirname(path);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: DIR_MODE });
            chmodSync(dir, DIR_MODE);
        }

        if (!tightened.has(path)) {
            // A log that pre-dates this code keeps whatever mode it was created with, so the
            // fix would never reach a machine that already had one. Checked ONCE per process,
            // not per record: a hook writes one or two records and then exits.
            tightened.add(path);

            try {
                const stat = statSync(path);

                if ((stat.mode & 0o077) !== 0) {
                    chmodSync(path, FILE_MODE);
                }

                sizes.set(path, stat.size);
            } catch {
                // The log does not exist yet. `appendFileSync`'s mode creates it correctly.
            }
        }

        // `appendFileSync` with a mode, never `writeFileSync(path, "")` first: that
        // TRUNCATES, and two hook processes running for parallel Bash calls can both see the
        // file as absent, so the second erases the line the first just wrote. The mode
        // applies at creation only, which is exactly what is wanted.
        const line = `${SafeJSON.stringify(record)}\n`;

        // Rotate BEFORE the write that would cross the cap, so the ceiling holds for every
        // writer rather than only for a process that exits after one record.
        if (sizeOf(path) + line.length > maxBytes) {
            rotate(path);
        }

        appendFileSync(path, line, { mode: FILE_MODE });
        sizes.set(path, sizeOf(path) + line.length);
    } catch {
        // Losing a log line is strictly better than failing the user's command, and there is
        // no second channel to report the failure on: pino is exactly what this avoids.
    }
}

/** One line per hook run. A log failure must never break the tool call. */
export function logDecision(record: DecisionRecord, logPath: string): void {
    append(logPath, record);
}

/** A caught error on the hot path. Never thrown, never swallowed: it lands in the log. */
export function hookDiag(reason: string, fields: Record<string, unknown> = {}): void {
    append(diagPath, {
        at: new Date().toISOString(),
        phase: "diag",
        decision: "caught",
        reason,
        ...fields,
        ...(fields.err instanceof Error ? { err: `${fields.err.name}: ${fields.err.message}` } : {}),
    });
}
