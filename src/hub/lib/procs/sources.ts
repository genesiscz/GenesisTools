import { realpathSync } from "node:fs";
import { listAgentSessionRows, POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import { logger } from "@genesiscz/utils/logger";
import { capture } from "@genesiscz/utils/process/capture";
import { ownLineage, readProcessCwd } from "@genesiscz/utils/process/cwd";
import { parseLaunchctlList } from "@genesiscz/utils/process/launchctl";
import {
    commandOfRow,
    listProcessTable,
    type ProcessTableRow,
    readCpuPercent,
    readProcessUsage,
} from "@genesiscz/utils/process/libproc-table";
import { listProcessRows, type PsRow, userName } from "@genesiscz/utils/process/processes";
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
        if (!isMissingPathError(err)) {
            log.debug({ err, path }, "realpath failed; comparing the path as given");
        }

        return path;
    }
}

/** What the kernel table reads of one process; tests pass fakes. */
export interface KernelTableReaders {
    rows(): ProcessTableRow[] | null;
    command(row: ProcessTableRow): string;
    usage(pid: number): { rssBytes: number; running: boolean } | null;
    cpuPercent(pid: number): number | null;
    userName(uid: number): string | null;
}

const kernelReaders: KernelTableReaders = {
    rows: listProcessTable,
    command: commandOfRow,
    usage: readProcessUsage,
    cpuPercent: readCpuPercent,
    userName,
};

/**
 * The table `ps -axo pid=,ppid=,user=,state=,pcpu=,rss=,lstart=,command=` printed, read from the kernel in this
 * process: no `ps` is started. Null where the kernel reader does not work (not macOS, a failed self-check), so the
 * caller keeps `ps`. Until 2026-11-10 every report started that `ps`: 133 to 466 an hour from the hub server, and at
 * a load average of 300 to 800 a read took 7 s (p50) and 244 were killed at their limit in six hours.
 * Another user's process has its executable path as its command and no CPU or memory (the kernel withholds them, as
 * in `listHostProcesses`); the report builds its groups from this user's agents, shells and MCP servers.
 */
export function kernelProcsTable(readers: KernelTableReaders = kernelReaders): PsRow[] | null {
    const rows = readers.rows();

    if (rows === null) {
        return null;
    }

    const table: PsRow[] = [];

    for (const row of rows) {
        // `ps -ax` has no row for the kernel (pid 0).
        if (row.pid <= 0) {
            continue;
        }

        const usage = row.zombie ? null : readers.usage(row.pid);
        table.push({
            pid: row.pid,
            ppid: row.ppid,
            user: readers.userName(row.uid) ?? String(row.uid),
            stat: usage?.running ? "R" : row.state,
            cpu: (row.zombie ? null : readers.cpuPercent(row.pid)) ?? 0,
            rss: usage ? Math.round(usage.rssBytes / 1024) : 0,
            // Whole seconds, as `ps lstart` prints: a stop compares this with `ps -p` before it signals.
            startTime: new Date(Math.floor(row.startMs / 1000) * 1000),
            command: readers.command(row),
        });
    }

    return table;
}

/** The kernel table where it answers, else the process layer's rows (one `ps` bounded by `psTimeoutMs` at most). */
async function readTable(psTimeoutMs: number): Promise<PsRow[]> {
    return kernelProcsTable() ?? listProcessRows({ timeoutMs: psTimeoutMs });
}

export const realProcsSources: ProcsSources = {
    table: () => readTable(PS_TIMEOUT_MS),
    cwdOf: (pid) => {
        const cwd = readProcessCwd(pid);
        return cwd && cwd !== "/" ? realpathOr(cwd) : null;
    },
    sessions: async () => {
        try {
            return await listAgentSessionRows({
                hours: SESSION_HOURS,
                refresh: false,
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
 * One refresh of the resource monitor: ONE read of the kernel's table (one `ps` where it does not answer), libproc
 * for the roots' folders, the polled session listing, `launchctl list` only when launchd adopted a candidate, and `top` only with
 * `energy`.
 */
/**
 * The session ids a live agent process holds, from one process-table read: an open terminal tab or app window,
 * however long ago its transcript was written. A session waiting for its user writes nothing, so a transcript
 * clock alone calls an open, idle session "not live" (the hub's Agents tab said "No live agent sessions" for two
 * open ones on 2026-10-16).
 */
export async function openAgentSessionIds(
    sources?: ProcsSources,
    options: { psTimeoutMs?: number } = {}
): Promise<Set<string>> {
    const psTimeoutMs = options.psTimeoutMs;
    // Injected sources (tests) keep their own table; the bound applies to the real `ps` only.
    const bounded =
        sources ??
        (psTimeoutMs === undefined ? realProcsSources : { ...realProcsSources, table: () => readTable(psTimeoutMs) });
    const report = await readProcsReport({ sources: bounded });
    return new Set(
        report.groups.flatMap((group) =>
            group.kind === "agent" && group.session && group.session.match !== "cwd" ? [group.session.sessionId] : []
        )
    );
}

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
