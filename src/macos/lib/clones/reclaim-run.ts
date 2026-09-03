import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "clones:reclaim-run" });
const storage = new Storage("macos-clones");

export interface ReclaimEvent {
    ts: string;
    phase: string;
    [key: string]: unknown;
}

let counter = 0;

/** Filename-safe UTC id + pid + in-process counter, so two runs started in the
 *  same millisecond by the same process still get separate logs. */
export function newReclaimRunId(): string {
    counter += 1;
    return `${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}.${counter}`;
}

export function reclaimDir(): string {
    const dir = join(storage.getBaseDir(), "reclaim");
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function reclaimRunPath(id: string): string {
    return join(reclaimDir(), `${id}.jsonl`);
}

/** `Omit<ReclaimEvent, "ts">` would erase `phase` behind the index signature,
 *  so the required key is spelled out. */
export function appendReclaimEvent(id: string, event: { phase: string } & Record<string, unknown>): void {
    const row: ReclaimEvent = { ts: new Date().toISOString(), ...event };
    try {
        appendFileSync(reclaimRunPath(id), `${SafeJSON.stringify(row)}\n`);
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
