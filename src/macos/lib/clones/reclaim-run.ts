import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { appendRunLogRow, newRunLogId, runLogDir, runLogPath } from "./audit";

const log = logger.child({ component: "clones:reclaim-run" });

/** The reclaim run log lives beside the apply audit log, on the same JSONL
 *  primitives — one mechanism, one convention, one place to fix. */
const RECLAIM_LOG_DIR = "reclaim";

export interface ReclaimEvent {
    ts: string;
    phase: string;
    [key: string]: unknown;
}

export function newReclaimRunId(): string {
    return newRunLogId({ counter: true });
}

export function reclaimDir(): string {
    return runLogDir(RECLAIM_LOG_DIR);
}

export function reclaimRunPath(id: string): string {
    return runLogPath(RECLAIM_LOG_DIR, id);
}

/** `Omit<ReclaimEvent, "ts">` would erase `phase` behind the index signature,
 *  so the required key is spelled out. */
export function appendReclaimEvent(id: string, event: { phase: string } & Record<string, unknown>): void {
    const row: ReclaimEvent = { ts: new Date().toISOString(), ...event };
    try {
        appendRunLogRow(RECLAIM_LOG_DIR, id, row);
    } catch (err) {
        log.warn({ err, id, phase: event.phase }, "reclaim event append failed");
    }
}

export function readReclaimEvents(id: string): ReclaimEvent[] {
    const path = reclaimRunPath(id);
    if (!existsSync(path)) {
        return [];
    }

    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => SafeJSON.parse(line) as ReclaimEvent);
}
