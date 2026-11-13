import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPidRecord, takeOverStaleClaim } from "@genesiscz/utils/process/pidfile";

const log = logger.child({ component: "storage:stale-lock-sweep" });

export interface LockPayload {
    pid: number;
    since?: string;
    /** Command line of `pid` at lock time — enables pid-reuse detection. */
    command?: string;
    [k: string]: unknown;
}

export interface ReapedLock {
    lock: string;
    pid?: number;
    reason: "dead_pid" | "recycled_pid" | "unreadable";
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

interface JudgedHolder {
    payload: LockPayload;
    reason: "dead_pid" | "recycled_pid";
    command: string | null;
}

export interface SweepOptions {
    maxAgeHours?: number;
    matchExtensions?: string[];
}

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_EXTENSIONS = [".lock", ".login"];

function parsePayload(text: string): LockPayload | null {
    try {
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

/**
 * Reap the dead claims in `dir` through the shared fenced takeover (`takeOverStaleClaim` in pidfile.ts): each holder is
 * read again and judged under its arbiter, and removed only when the removed bytes are the judged ones. An empty or
 * unreadable claim follows pidfile.ts's one rule (held inside its grace, reaped after it). Live claims older than
 * `maxAgeHours` are reported as warnings and left in place.
 */
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

        // The verdict is made by the shared takeover on what it reads under the lock's arbiter, never on an earlier
        // read: a holder that died can be replaced by a fresh login between a read here and the unlink.
        const seen: { holder?: JudgedHolder } = {};
        const outcome = takeOverStaleClaim(fullPath, {
            arbiter: fullPath,
            holderIsStale: (holder, raw) => {
                const identity = classifyPidRecord(holder);
                const stale = identity.status === "dead" || identity.status === "foreign";
                seen.holder = {
                    payload: parsePayload(raw) ?? { pid: holder.pid },
                    reason: identity.status === "dead" ? "dead_pid" : "recycled_pid",
                    command: identity.command ?? null,
                };
                return stale;
            },
        });

        if (outcome === "taken") {
            if (seen.holder) {
                const { payload, reason, command } = seen.holder;
                report.reaped.push({ lock: fullPath, pid: payload.pid, reason, payload });
                log.info({ lock: fullPath, pid: payload.pid, reason, command }, "reaped stale lock");
            } else {
                // A holder that names no process is taken over without a verdict, past pidfile.ts's grace.
                report.reaped.push({ lock: fullPath, reason: "unreadable", payload: { pid: 0 } });
                log.warn({ lock: fullPath }, "reaped unreadable lock file");
            }

            continue;
        }

        // Gone, decided by another process, or an empty claim inside its grace: nothing to warn about.
        if (outcome === "lost-race" || !seen.holder) {
            continue;
        }

        const { payload } = seen.holder;
        const ageMs = now - stat.mtimeMs;
        const ageH = ageMs / 3_600_000;

        if (ageH >= maxAgeHours) {
            report.warnings.push({ lock: fullPath, pid: payload.pid, age_h: Number(ageH.toFixed(2)), payload });
            log.warn({ lock: fullPath, pid: payload.pid, age_h: ageH }, "lock alive but older than warning threshold");
        }
    }

    return report;
}
