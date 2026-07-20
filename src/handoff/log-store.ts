import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { HandoffEvent } from "./types";

/** Handoffs share the question family's storage root (§6.2) — honor its override too. */
function questionRoot(): string {
    const logBase = env.question.getLogBase();

    return logBase !== undefined ? dirname(logBase) : join(homedir(), ".genesis-tools", "question");
}

export function handoffLogDir(base?: string): string {
    return base ?? join(questionRoot(), "handoff");
}

export function logFilePathForTs(tsIso: string, base?: string): string {
    const d = new Date(tsIso);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return join(handoffLogDir(base), `${day}.jsonl`);
}

export function todayHandoffLogFile(base?: string): string {
    return logFilePathForTs(new Date().toISOString(), base);
}

/**
 * Append a batch of events. One appendFileSync per target file (O_APPEND: the
 * whole write lands atomically, so a multi-action call's events stay contiguous
 * within this process's write — though interleaving with OTHER processes'
 * appends between calls is legal and handled by the fold, spec §6.1).
 */
export function appendHandoffEvents(events: HandoffEvent[], base?: string): string[] {
    if (events.length === 0) {
        return [];
    }

    mkdirSync(handoffLogDir(base), { recursive: true });
    const byFile = new Map<string, HandoffEvent[]>();

    for (const event of events) {
        const file = logFilePathForTs(event.ts, base);
        const bucket = byFile.get(file) ?? [];
        bucket.push(event);
        byFile.set(file, bucket);
    }

    const files: string[] = [];

    for (const [file, bucket] of byFile) {
        appendFileSync(file, `${bucket.map((e) => SafeJSON.stringify(e, { strict: true })).join("\n")}\n`);
        files.push(file);
    }

    return files;
}
