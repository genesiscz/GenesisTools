import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toPosixPath } from "@app/utils/paths";

export const DOCTOR_DIR = toPosixPath(join(homedir(), ".genesis-tools", "doctor"));
export const ANALYSIS_DIR = toPosixPath(join(DOCTOR_DIR, "analysis"));
export const CACHE_DIR = toPosixPath(join(DOCTOR_DIR, "cache"));
export const SNAPSHOTS_DIR = toPosixPath(join(DOCTOR_DIR, "global-packages-snapshots"));
export const HISTORY_FILE = toPosixPath(join(DOCTOR_DIR, "history.jsonl"));
export const BLACKLIST_FILE = toPosixPath(join(DOCTOR_DIR, "blacklist.json"));
export const STATS_FILE = toPosixPath(join(DOCTOR_DIR, "stats.json"));

export function analysisDirFor(runId: string): string {
    return toPosixPath(join(ANALYSIS_DIR, runId));
}

export function cacheFilePath(analyzerId: string): string {
    return toPosixPath(join(CACHE_DIR, `${analyzerId}.json`));
}

export function snapshotFilePath(runId: string, manager: string): string {
    return toPosixPath(join(SNAPSHOTS_DIR, `${runId}-${manager}.json`));
}

export function makeRunId(now: Date = new Date()): string {
    return now.toISOString().replace(/[:.]/g, "-");
}

export function ensureDirs(runId?: string): void {
    for (const dir of [DOCTOR_DIR, ANALYSIS_DIR, CACHE_DIR, SNAPSHOTS_DIR]) {
        mkdirSync(dir, { recursive: true });
    }

    if (runId) {
        mkdirSync(analysisDirFor(runId), { recursive: true });
    }
}
