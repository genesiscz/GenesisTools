/**
 * Progress journal for `play run`, so a killed run resumes instead of restarting.
 *
 * Two files, two jobs. `progress.jsonl` is append-only, one entry per track attempt,
 * keyed by the tracks file so several candidate lists can interleave. `state.json` is a
 * one-glance "where did this stop" object rewritten after every track, with the resume
 * command already spelled out — the append-only journal holds the same facts but answering
 * "where was I" from it means parsing hundreds of lines.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { playDir } from "@app/spotify/lib/paths";
import { formatWindows, type PlayWindow } from "@app/spotify/lib/play/plan";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:play" });

export interface JournalEntry {
    ts: string;
    tracksFile: string;
    index: number;
    uri: string;
    name: string;
    status: "ok" | "fail";
    /** What was actually heard per window (`0:10→0:13`), or the failure reason. */
    heard?: string;
}

export function journalPath(): string {
    return join(playDir(), "progress.jsonl");
}

export function statePath(): string {
    return join(playDir(), "state.json");
}

export function readJournal(): JournalEntry[] {
    const path = journalPath();
    if (!existsSync(path)) {
        return [];
    }

    // One torn line must not cost the whole journal. `appendFileSync` interrupted mid-write
    // leaves a partial record, and throwing here breaks BOTH `play status` and
    // `play run --resume` until the user deletes the file — losing the progress the journal
    // exists to protect. A skipped line is one track replayed; a throw is all of them.
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
            try {
                return [SafeJSON.parse(line, { strict: true }) as JournalEntry];
            } catch (error) {
                log.warn({ error, line: line.slice(0, 120) }, "skipping an unreadable journal line");

                return [];
            }
        });
}

export function appendJournal(entry: JournalEntry): void {
    mkdirSync(playDir(), { recursive: true });
    appendFileSync(journalPath(), `${SafeJSON.stringify(entry)}\n`);
}

/** Drops this tracks file's entries; other candidate lists keep their progress. */
export function clearJournal(tracksFile: string): number {
    const all = readJournal();
    const kept = all.filter((e) => e.tracksFile !== tracksFile);

    if (kept.length !== all.length) {
        mkdirSync(playDir(), { recursive: true });
        atomicWriteFileSync(journalPath(), kept.length ? `${kept.map((e) => SafeJSON.stringify(e)).join("\n")}\n` : "");
    }

    return all.length - kept.length;
}

export interface JournalProgress {
    entries: JournalEntry[];
    okIndexes: Set<number>;
    failed: number;
    last?: JournalEntry;
}

export function progressFor(tracksFile: string): JournalProgress {
    const entries = readJournal().filter((e) => e.tracksFile === tracksFile);
    const okIndexes = new Set(entries.filter((e) => e.status === "ok").map((e) => e.index));

    return {
        entries,
        okIndexes,
        failed: entries.filter((e) => e.status === "fail").length,
        last: entries[entries.length - 1],
    };
}

export interface RunState {
    updatedAt: string;
    tracksFile: string;
    windows: PlayWindow[];
    queue: boolean;
    total: number;
    done: number;
    failed: number;
    lastIndex: number | null;
    lastTrack: string | null;
    nextIndex: number | null;
    status: "running" | "finished" | "aborted";
    resumeCommand: string;
}

export function writeState(state: Omit<RunState, "updatedAt" | "resumeCommand">): void {
    const full: RunState = {
        ...state,
        updatedAt: new Date().toISOString(),
        resumeCommand:
            `tools spotify play run --tracks ${state.tracksFile}` +
            ` --windows ${formatWindows(state.windows)}${state.queue ? "" : " --no-queue"} --resume`,
    };
    mkdirSync(playDir(), { recursive: true });
    atomicWriteFileSync(statePath(), `${SafeJSON.stringify(full, null, 2)}\n`);
}
