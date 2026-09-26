import { realpathSync } from "node:fs";
import { listAgentSessionRows, POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { logger } from "@genesiscz/utils/logger";
import { readParentPid, readProcessCwd } from "@genesiscz/utils/process/cwd";
import { capture, listPsTable, type PsRow } from "@genesiscz/utils/process/ps";
import { buildProcsReport, type ProcsReport, type SessionLike } from "./tree";

const log = logger.child({ component: "hub/procs" });

const PS_TIMEOUT_MS = 10_000;
const LAUNCHCTL_TIMEOUT_MS = 5_000;
/** Two `top` samples one second apart: the first sample's POWER column is always zero. */
const TOP_TIMEOUT_MS = 8_000;
/** How many of the most power-hungry processes one `top` sample lists; the rest read as 0. */
const TOP_ROWS = 300;
const SESSION_HOURS = 72;

/** Everything the report reads from the machine; tests pass fakes, so nothing real is listed or signalled. */
export interface ProcsSources {
    table(): Promise<PsRow[]>;
    cwdOf(pid: number): string | null;
    sessions(): Promise<SessionLike[]>;
    launchd(): Promise<Map<number, string>>;
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

/** `launchctl list`: `PID\tStatus\tLabel`, a `-` pid for a job that is not running. */
export function parseLaunchctlList(stdout: string): Map<number, string> {
    const jobs = new Map<number, string>();

    for (const line of stdout.split("\n")) {
        const [pid, , label] = line.split("\t");
        const value = Number.parseInt(pid ?? "", 10);

        if (Number.isInteger(value) && value > 0 && label) {
            jobs.set(value, label.trim());
        }
    }

    return jobs;
}

/** The last `PID POWER` table of `top -l 2 -stats pid,power` (the first sample has no power figures). */
export function parseTopPower(stdout: string): Map<number, number> {
    const power = new Map<number, number>();
    const at = stdout.lastIndexOf("PID");

    if (at < 0) {
        return power;
    }

    for (const line of stdout.slice(at).split("\n").slice(1)) {
        const match = line.trim().match(/^(\d+)\s+([\d.]+)/);

        if (match) {
            power.set(Number.parseInt(match[1], 10), Number.parseFloat(match[2]));
        }
    }

    return power;
}

/** This process and its ancestors: the tree that asked must never be stopped by its own request. */
export function ownLineage(): Set<number> {
    const own = new Set<number>();
    let pid: number | null = process.pid;

    while (pid !== null && pid > 1 && !own.has(pid) && own.size < 64) {
        own.add(pid);
        pid = readParentPid(pid);
    }

    return own;
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
    launchd: async () => {
        const result = await capture("launchctl", ["list"], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });

        if (result.status !== 0) {
            log.warn(
                { status: result.status, stderr: result.stderr.trim() },
                "launchctl list failed; no launchd job is recognised"
            );
        }

        return parseLaunchctlList(result.stdout);
    },
    energy: async () => {
        const result = await capture(
            "top",
            ["-l", "2", "-s", "1", "-stats", "pid,power", "-o", "power", "-n", String(TOP_ROWS)],
            {
                timeoutMs: TOP_TIMEOUT_MS,
            }
        );

        if (result.status !== 0) {
            log.warn({ status: result.status, stderr: result.stderr.trim() }, "top failed; energy stays unknown");
        }

        return parseTopPower(result.stdout);
    },
    own: ownLineage,
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
            launchdJobs: launchd.size,
            energy,
            elapsedMs,
        },
        "procs report"
    );
    return { ...report, elapsedMs, warnings };
}
