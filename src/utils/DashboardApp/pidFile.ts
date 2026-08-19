/**
 * PID file lifecycle for DashboardApp.
 *
 * Layout (per design decision §3 in the plan):
 *   PID:  ~/.genesis-tools/dashboards/<key>.pid
 *   Log:  ~/.genesis-tools/logs/<key>.bg.log
 *
 * The pid-reuse handling that used to live here (a bespoke `<pid>\n<command>`
 * file plus a local classifier) now comes from `@genesiscz/utils/process/pidfile`,
 * which is the one place that knows how to make a pid verifiable. This module
 * keeps the key-addressed API its callers use; files in the old two-line
 * format are still read, and get rewritten as records on the next `writePid`.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    clearPidFile,
    inspectPidFile,
    readLivePid,
    readPidRecord,
    writePidFile,
} from "@genesiscz/utils/process/pidfile";
import type { PidIdentity } from "@genesiscz/utils/process-identity";

const DASHBOARDS_DIR = join(env.tools.getHome(), ".genesis-tools", "dashboards");
const LOGS_DIR = join(env.tools.getHome(), ".genesis-tools", "logs");

export function pidFilePath(key: string): string {
    return join(DASHBOARDS_DIR, `${key}.pid`);
}

export function logFilePath(key: string): string {
    return join(LOGS_DIR, `${key}.bg.log`);
}

export function configFilePath(key: string): string {
    return join(DASHBOARDS_DIR, `${key}.config.json`);
}

function ensureDir(file: string): void {
    const dir = dirname(file);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export function writePid(key: string, pid: number): void {
    const file = pidFilePath(key);
    ensureDir(file);
    writePidFile(file, { pid });
}

/** The command line captured when the pid file was written, if any. */
export function readPidCommand(key: string): string | null {
    return readPidRecord(pidFilePath(key))?.command ?? null;
}

/**
 * Classify the recorded pid against the command line captured at write time.
 * Returns null when no pid is recorded. "unverified" (pre-identity pid file,
 * or `ps` unavailable) should be treated as running, matching old behavior.
 */
export function classifyDashboardPid(key: string): PidIdentity | null {
    const state = inspectPidFile(pidFilePath(key));

    if (state.status === "none") {
        return null;
    }

    // `foreign` must report the command of whoever holds the pid NOW — that is
    // what the caller shows the user, not the identity we recorded.
    const command = state.status === "foreign" ? state.command : (state.record.command ?? undefined);

    return { status: state.status, pid: state.pid, command };
}

export function readPidRaw(key: string): number | null {
    return readPidRecord(pidFilePath(key))?.pid ?? null;
}

/**
 * Returns the PID written for this dashboard if (a) the file exists and (b)
 * the PID is alive and still that dashboard. Returns null otherwise — the file
 * is left in place (caller decides whether to clear stale entries via
 * `clearPid`).
 */
export function readPid(key: string): number | null {
    return readLivePid(pidFilePath(key));
}

/**
 * Unconditional: callers clear records that belong to a pid which was recycled
 * onto someone else, so this must not be gated on still owning the file.
 */
export function clearPid(key: string): void {
    clearPidFile(pidFilePath(key), { force: true });
}

/**
 * Best-effort start time for a running pid, from the PID file's mtime. Returns
 * null when the file is missing.
 */
export function pidFileStartTime(key: string): Date | null {
    const file = pidFilePath(key);
    if (!existsSync(file)) {
        return null;
    }

    return statSync(file).mtime;
}

export function ensureLogFile(key: string): string {
    const file = logFilePath(key);
    ensureDir(file);
    return file;
}
