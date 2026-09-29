import { realpathSync } from "node:fs";
import { listAgentSessionRows, POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { logger } from "@genesiscz/utils/logger";
import { ownLineage, readProcessCwd } from "@genesiscz/utils/process/cwd";
import { parseLaunchctlList } from "@genesiscz/utils/process/launchctl";
import { capture, listPsTable, type PsRow } from "@genesiscz/utils/process/ps";
import { readTopEnergy } from "@genesiscz/utils/process/top";
import { buildProcsReport, type ProcsReport, type SessionLike } from "./tree";

const log = logger.child({ component: "hub/procs" });

const PS_TIMEOUT_MS = 10_000;
const LAUNCHCTL_TIMEOUT_MS = 5_000;
const SESSION_HOURS = 72;

/** Everything the report reads from the machine; tests pass fakes, so nothing real is listed or signalled. */
export interface ProcsSources {
    table(): Promise<PsRow[]>;
    cwdOf(pid: number): string | null;
    sessions(): Promise<SessionLike[]>;
    /** Running launchd jobs (pid -> label), or null when `launchctl list` failed and no job is known. */
    launchd(): Promise<Map<number, string> | null>;
    energy(): Promise<Map<number, number>>;
    own(): Set<number>;
    realpath(path: string): string;
    now(): number;
}

function realpathOr(path: string): string {
    try {
        return realpathSync(path);
    } catch (err) {
        log.debug({ err, path }, "realpath failed; comparing the path as given");
        return path;
    }
}

export const realProcsSources: ProcsSources = {
    table: () => listPsTable({ timeoutMs: PS_TIMEOUT_MS }),
    cwdOf: (pid) => {
        const cwd = readProcessCwd(pid);
        return cwd && cwd !== "/" ? realpathOr(cwd) : null;
    },
    sessions: async () => {
        try {
            return await listAgentSessionRows({
                hours: SESSION_HOURS,
                withUsage: false,
                maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
            });
        } catch (err) {
            log.warn({ err }, "agent sessions unreadable; processes are listed without their sessions");
            return [];
        }
    },
    // A failed or partial listing is not an empty one: null keeps every PPID-1 process out of the orphans.
    launchd: async () => {
        try {
            const result = await capture("launchctl", ["list"], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });

            if (result.status !== 0) {
                log.warn(
                    { status: result.status, stderr: result.stderr.trim() },
                    "launchctl list failed; launchd jobs are unknown, so no PPID-1 process counts as an orphan"
                );
                return null;
            }

            return parseLaunchctlList(result.stdout);
        } catch (err) {
            log.warn({ err }, "launchctl list could not run; launchd jobs are unknown");
            return null;
        }
    },
    energy: () => readTopEnergy(),
    own: () => ownLineage(),
    realpath: realpathOr,
    now: () => Date.now(),
};

/**
 * One refresh of the resource monitor: ONE `ps` for the table, libproc for the roots' folders, the
 * polled session listing, `launchctl list` only when launchd adopted a candidate, and `top` only with
 * `energy`.
 */
export async function readProcsReport({
    energy = false,
    sources = realProcsSources,
}: {
    energy?: boolean;
    sources?: ProcsSources;
} = {}): Promise<ProcsReport> {
    const started = performance.now();
    const warnings: string[] = [];
    const [table, power] = await Promise.all([sources.table(), energy ? sources.energy() : Promise.resolve(null)]);

    if (table.length === 0) {
        warnings.push("ps returned no processes; the list is empty because it could not be read");
    }

    if (energy && power?.size === 0) {
        warnings.push("top returned no energy figures");
    }

    const adopted = table.some((row) => row.ppid === 1);
    const [sessions, launchd] = await Promise.all([
        sources.sessions(),
        adopted ? sources.launchd() : Promise.resolve(new Map<number, string>()),
    ]);

    if (launchd === null) {
        warnings.push(
            "launchctl list failed, so launchd jobs are unknown: no PPID-1 process counts as an orphan, and none is stopped as one"
        );
    }

    const report = buildProcsReport({
        table,
        now: sources.now(),
        own: sources.own(),
        cwdOf: sources.cwdOf,
        sessions,
        launchd,
        energy: power,
        realpath: sources.realpath,
    });
    const elapsedMs = Math.round(performance.now() - started);
    log.info(
        {
            processes: table.length,
            groups: report.totals.groups,
            orphans: report.totals.orphans,
            idle: report.totals.idle,
            sessions: sessions.length,
            launchdJobs: launchd?.size ?? null,
            energy,
            elapsedMs,
        },
        "procs report"
    );
    return { ...report, elapsedMs, warnings };
}
