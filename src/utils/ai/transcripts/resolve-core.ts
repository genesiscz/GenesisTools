import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { FolderReads, RankedHit, ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import type { TranscriptProvider } from "./types";

export function idMatches(query: string, candidate: string): boolean {
    const q = query.toLowerCase();
    const c = candidate.toLowerCase();
    if (c === q) {
        return true;
    }
    if (q.length >= 8 && (c.startsWith(q) || c.includes(q))) {
        return true;
    }
    return false;
}

export function mtimeOf(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "[transcripts] could not stat a transcript");
        return 0;
    }
}

export function listDir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch (err) {
        logger.debug({ err, path }, "[transcripts] could not list a directory");
        return [];
    }
}

export function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function turnNumber(file: string): number {
    const match = file.match(/\.turn(\d+)\.jsonl$/);
    return match ? Number(match[1]) : 0;
}

/**
 * A worker turn file is EXACTLY `<name>.turn<N>.jsonl`.
 *
 * `startsWith(`${name}.turn`)` was not that test. For a worker named "task" it
 * also accepted "task.turnover.turn2.jsonl", which belongs to a DIFFERENT
 * worker, and `turnNumber()` then read it as turn 2 — so follow mode could
 * switch to another session's transcript (PR #341 review t6). Checking the
 * remainder rather than interpolating `name` into a pattern also means the
 * name never needs regex-escaping.
 */
function isTurnFileFor(name: string, file: string): boolean {
    const prefix = `${name}.turn`;

    return file.startsWith(prefix) && /^\d+\.jsonl$/.test(file.slice(prefix.length));
}

/** A worker's turn file, with the chain after it, so a steer's next turn file is followed. */
export function workerTurnChain(input: {
    provider: TranscriptProvider;
    stem: string;
    filePath: string;
}): ResolvedTranscript {
    const name = input.stem.replace(/\.turn\d+$/, "");
    const self: ResolvedTranscript = {
        provider: input.provider,
        source: "worker",
        sessionId: name,
        filePath: input.filePath,
    };
    return { ...self, ...(rescanWorkerTurns(self) ?? {}) };
}

/**
 * A `<name>.meta.json` + `<name>.turn<N>.jsonl` worker directory, the layout
 * `tools grok` and `tools claude worker` share. Matches the worker name or the
 * session uuid in its meta; the latest turn file is the head, earlier ones the chain.
 */
export function findTurnFileWorker(
    query: string,
    workerDir: string,
    provider: TranscriptProvider,
    fs: FolderReads
): RankedHit[] {
    const hits: RankedHit[] = [];
    const entries = fs.listDir(workerDir);
    for (const entry of entries) {
        if (!entry.endsWith(".meta.json")) {
            continue;
        }
        const name = entry.slice(0, -".meta.json".length);
        let sessionId = name;
        try {
            const meta = SafeJSON.parse(fs.readText(join(workerDir, entry)));
            if (isObject(meta) && typeof meta.sessionId === "string" && meta.sessionId) {
                sessionId = meta.sessionId;
            }
        } catch {
            // Name-only match still works when meta is unreadable.
        }
        if (!idMatches(query, name) && !idMatches(query, sessionId)) {
            continue;
        }
        const turns = entries
            .filter((file) => isTurnFileFor(name, file))
            .sort((a, b) => turnNumber(a) - turnNumber(b))
            .map((file) => join(workerDir, file));
        if (turns.length === 0) {
            continue;
        }
        const filePath = turns[turns.length - 1];
        const extraFiles = turns.slice(0, -1);
        hits.push({
            provider,
            source: "worker",
            sessionId,
            filePath,
            extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
            mtime: fs.mtimeOf(filePath),
        });
    }
    return hits;
}

/**
 * Re-read a worker session's turn files, for follow mode.
 *
 * A worker session is a SEQUENCE of `<name>.turn<N>.jsonl`, and the next steer
 * writes a new one. `followTranscript` tails a single path, so without this it
 * silently stopped updating at the turn that existed when it started
 * (PR #341 review round 4, t2).
 */
export function rescanWorkerTurns(resolved: ResolvedTranscript): { filePath: string; extraFiles?: string[] } | null {
    if (resolved.source !== "worker") {
        return null;
    }

    const dir = dirname(resolved.filePath);
    const base = basename(resolved.filePath);
    const match = /^(.*)\.turn\d+\.jsonl$/.exec(base);

    if (!match) {
        return null;
    }

    const name = match[1];
    const turns = listDir(dir)
        .filter((file) => isTurnFileFor(name, file))
        .sort((a, b) => turnNumber(a) - turnNumber(b))
        .map((file) => join(dir, file));

    if (turns.length === 0) {
        return null;
    }

    const filePath = turns[turns.length - 1];
    const extraFiles = turns.slice(0, -1);
    return { filePath, extraFiles: extraFiles.length > 0 ? extraFiles : undefined };
}
