/**
 * PID file lifecycle for DashboardApp.
 *
 * Layout (per design decision §3 in the plan):
 *   PID:  ~/.genesis-tools/dashboards/<key>.pid
 *   Log:  ~/.genesis-tools/logs/<key>.bg.log
 *
 * Pattern ported from src/youtube/lib/server/daemon.ts. We keep DashboardApp's
 * pidFile module self-contained instead of importing youtube/lib so the
 * dependency graph stays one-way (youtube → DashboardApp, never back).
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DASHBOARDS_DIR = join(homedir(), ".genesis-tools", "dashboards");
const LOGS_DIR = join(homedir(), ".genesis-tools", "logs");

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
    writeFileSync(file, String(pid));
}

export function readPidRaw(key: string): number | null {
    const file = pidFilePath(key);

    if (!existsSync(file)) {
        return null;
    }

    const raw = readFileSync(file, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);

    if (Number.isNaN(pid) || pid <= 0) {
        return null;
    }

    return pid;
}

/**
 * Returns the PID written for this dashboard if (a) the file exists and (b)
 * the PID is alive. Returns null otherwise — the file is left in place (caller
 * decides whether to clear stale entries via `clearPid`).
 */
export function readPid(key: string): number | null {
    const pid = readPidRaw(key);

    if (pid === null) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return pid;
    } catch (err) {
        if (process.platform === "win32" && err instanceof Error && "code" in err) {
            return (err as { code?: string }).code === "EPERM" ? pid : null;
        }

        return null;
    }
}

export function clearPid(key: string): void {
    const file = pidFilePath(key);
    if (existsSync(file)) {
        unlinkSync(file);
    }
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
