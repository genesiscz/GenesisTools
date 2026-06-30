import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isProcessAlive } from "@app/utils/process-alive";

const log = logger.child({ component: "storage:stale-lock-sweep" });

export interface LockPayload {
    pid: number;
    since?: string;
    [k: string]: unknown;
}

export interface ReapedLock {
    lock: string;
    pid?: number;
    reason: "dead_pid" | "unreadable";
    payload: LockPayload;
}

export interface WarningLock {
    lock: string;
    pid: number;
    age_h: number;
    payload: LockPayload;
}

export interface SweepReport {
    reaped: ReapedLock[];
    warnings: WarningLock[];
    inspected: number;
}

export interface SweepOptions {
    maxAgeHours?: number;
    matchExtensions?: string[];
}

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_EXTENSIONS = [".lock", ".login"];

function parsePayload(path: string): LockPayload | null {
    try {
        const text = readFileSync(path, "utf8");
        const trimmed = text.trim();

        if (!trimmed) {
            return null;
        }

        if (/^\d+$/.test(trimmed)) {
            return { pid: Number.parseInt(trimmed, 10) };
        }

        const parsed = SafeJSON.parse(trimmed) as Partial<LockPayload>;

        if (typeof parsed.pid !== "number") {
            return null;
        }

        return parsed as LockPayload;
    } catch {
        return null;
    }
}

export function sweepStaleLocks(dir: string, opts: SweepOptions = {}): SweepReport {
    const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
    const extensions = opts.matchExtensions ?? DEFAULT_EXTENSIONS;
    const report: SweepReport = { reaped: [], warnings: [], inspected: 0 };

    if (!existsSync(dir)) {
        return report;
    }

    const entries = readdirSync(dir);
    const now = Date.now();

    for (const entry of entries) {
        if (!extensions.some((ext) => entry.endsWith(ext))) {
            continue;
        }

        const fullPath = join(dir, entry);
        let stat: ReturnType<typeof statSync>;

        try {
            stat = statSync(fullPath);
        } catch {
            continue;
        }

        if (!stat.isFile()) {
            continue;
        }

        report.inspected += 1;

        const payload = parsePayload(fullPath);

        if (!payload) {
            // Caller contracts (e.g. agents login's slot-already-held error) promise
            // unreadable locks are reaped on the next sweep attempt. writeFileSync
            // writes the payload in one syscall, so a corrupt/truncated file here is
            // a genuine fault, not a write-in-progress race — safe to reap outright.
            try {
                unlinkSync(fullPath);
                report.reaped.push({ lock: fullPath, reason: "unreadable", payload: { pid: 0 } });
                log.warn({ lock: fullPath }, "reaped unreadable lock file");
            } catch (err) {
                log.warn({ lock: fullPath, err }, "failed to unlink unreadable lock");
            }

            continue;
        }

        const alive = isProcessAlive(payload.pid);

        if (!alive) {
            try {
                unlinkSync(fullPath);
                report.reaped.push({ lock: fullPath, pid: payload.pid, reason: "dead_pid", payload });
                log.info({ lock: fullPath, pid: payload.pid }, "reaped stale lock (dead pid)");
            } catch (err) {
                log.warn({ lock: fullPath, err }, "failed to unlink stale lock");
            }

            continue;
        }

        const ageMs = now - stat.mtimeMs;
        const ageH = ageMs / 3_600_000;

        if (ageH >= maxAgeHours) {
            report.warnings.push({ lock: fullPath, pid: payload.pid, age_h: Number(ageH.toFixed(2)), payload });
            log.warn({ lock: fullPath, pid: payload.pid, age_h: ageH }, "lock alive but older than warning threshold");
        }
    }

    return report;
}
