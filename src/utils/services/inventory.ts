import { logger } from "@genesiscz/utils/logger";
import { classifyCommand } from "@genesiscz/utils/process/classify";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import { captureSync, PS_COLUMNS_SPEC, type PsRow, parsePsLine } from "@genesiscz/utils/process/ps";
import { listPortRegistry, type RegistryEntry } from "@genesiscz/utils/ui/dashboards";

/** Every GenesisTools launchd job carries this prefix (`src/utils/DashboardApp/launchd.ts`, `src/daemon`). */
export const LAUNCHD_PREFIX = "com.genesis-tools.";

export interface LaunchdJob {
    label: string;
    /** Null when launchd has the job loaded but it is not running. */
    pid: number | null;
}

/** What the inventory reads from the machine; injected in tests. */
export interface ServiceProbe {
    processes(): PsRow[];
    /** pid -> TCP ports it listens on. */
    listeners(): Map<number, number[]>;
    launchdJobs(): LaunchdJob[];
    cwd(pid: number): string | null;
}

export interface ServiceRow {
    /** The registry key (`youtube`) or, for a launchd job with no registered port, its label without the prefix. */
    id: string;
    name: string;
    port: number | null;
    /** The process listening on the port, or the launchd job's own pid. */
    pid: number;
    /** The topmost GenesisTools process of this service; stopping it and its subtree stops the service. */
    rootPid: number;
    /** The root and every process below it. */
    pids: number[];
    /**
     * The command line of each pid in `pids` as this inventory read it. A stop signals a pid only while
     * it still runs this command, since a pid that exited meanwhile may belong to an unrelated process.
     */
    commands: Record<number, string>;
    /** The root's working directory, where its relaunch arguments resolve; null when unreadable. */
    cwd: string | null;
    startedAt: number | null;
    managed: "launchd" | "detached";
    label: string | null;
    /** The registry's start command, when there is one. */
    launch: string | null;
    command: string;
    /**
     * `tools` arguments that start this exact process again (`artifact serve notes --port 3076`), read
     * from its own command lines; null when none names a tool.
     */
    relaunch: string[] | null;
}

/**
 * The `tools` arguments behind a command line: after `.../GenesisTools/tools `, or the tool of
 * `.../GenesisTools/src/<tool>/index.ts` plus what follows it. The first command, root first, that
 * names one wins. Arguments are split on spaces, which is how `ps` joined them.
 */
export function relaunchArgs(commands: string[]): string[] | null {
    for (const command of commands) {
        const wrapper = /\/GenesisTools\/tools\s+(.+)$/.exec(command);

        if (wrapper?.[1]) {
            return wrapper[1].split(/\s+/);
        }

        const entry = /\/GenesisTools\/src\/([a-z0-9][a-z0-9-]*)\/index\.tsx?(?:\s+(.*))?$/.exec(command);

        if (entry?.[1]) {
            return [entry[1], ...(entry[2]?.trim() ? entry[2].trim().split(/\s+/) : [])];
        }
    }

    return null;
}

const GENESIS = /GenesisTools/;
/** Agent sessions and the task runner: never a service, and nothing under them is restarted. */
const SESSION_LAUNCHER = /\/\.genesis-tools\/bin\/gt-(?:cc|claude|codex|grok|cursor|task)\b/;

function isSession(command: string): boolean {
    if (SESSION_LAUNCHER.test(command)) {
        return true;
    }

    const kind = classifyCommand(command).kind;
    return kind === "agent" || kind === "wrapper";
}

/** `launchctl list` rows: `PID\tStatus\tLabel`, pid `-` when not running. */
export function parseLaunchctlList(stdout: string): LaunchdJob[] {
    return stdout.split("\n").flatMap((line) => {
        const [pid, , label] = line.split("\t");

        if (!label?.startsWith(LAUNCHD_PREFIX)) {
            return [];
        }

        const value = Number(pid);
        return [{ label, pid: Number.isInteger(value) && value > 0 ? value : null }];
    });
}

/** `lsof -Fpn` rows: `p<pid>` then one `n<address>:<port>` per listening socket. */
export function parseLsofListeners(stdout: string): Map<number, number[]> {
    const ports = new Map<number, number[]>();
    let pid: number | null = null;

    for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
            pid = Number(line.slice(1));
            continue;
        }

        const port = line.startsWith("n") ? Number(line.slice(line.lastIndexOf(":") + 1)) : Number.NaN;

        if (pid !== null && Number.isInteger(port)) {
            ports.set(pid, [...new Set([...(ports.get(pid) ?? []), port])]);
        }
    }

    return ports;
}

/**
 * Runs one probe command and logs how it went. A command that could not run (status null) left the
 * inventory blind, which once read as "no servers" under the daemon's PATH, so it is a warning.
 */
function probeRun(name: string, command: string, args: string[]): string {
    const run = captureSync(command, args);
    const fields = {
        probe: name,
        status: run.status,
        bytes: run.stdout.length,
        stderr: run.stderr.trim() || undefined,
    };

    if (run.status === null) {
        logger.warn(fields, "services: probe command did not run; the inventory is incomplete");
    } else {
        logger.debug(fields, "services: probe");
    }

    return run.stdout;
}

export function liveProbe(): ServiceProbe {
    return {
        processes: () => {
            // lstart is strftime's %c: a localized LC_TIME would spell it in words Date cannot read.
            const stdout = probeRun("processes", "env", ["LC_ALL=C", "ps", "-axo", PS_COLUMNS_SPEC]);
            return stdout.split("\n").flatMap((line) => parsePsLine(line) ?? []);
        },
        listeners: () => parseLsofListeners(probeRun("listeners", "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])),
        launchdJobs: () => parseLaunchctlList(probeRun("launchd", "launchctl", ["list"])),
        cwd: readProcessCwd,
    };
}

/**
 * Every long-running GenesisTools server on this Mac: a registered port whose listener passes the
 * registry entry's check, and every running `com.genesis-tools.*` launchd job. An agent session, or
 * anything started inside one, is never listed, so a restart cannot reach it.
 */
export function listServices(probe: ServiceProbe = liveProbe()): ServiceRow[] {
    const processes = new Map(probe.processes().map((row) => [row.pid, row]));
    const children = new Map<number, number[]>();

    for (const row of processes.values()) {
        children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
    }

    const jobs = probe.launchdJobs();
    const labelOf = new Map(jobs.flatMap((job) => (job.pid === null ? [] : [[job.pid, job.label] as const])));
    const ancestors = (pid: number): number[] => {
        const chain: number[] = [];
        let current = processes.get(pid);

        while (current && current.pid > 1 && chain.length < 64) {
            chain.push(current.pid);
            current = processes.get(current.ppid);
        }

        return chain;
    };
    const subtree = (root: number): number[] => {
        const found = [root];

        for (let index = 0; index < found.length; index++) {
            found.push(...(children.get(found[index] ?? 0) ?? []));
        }

        return found;
    };
    const describe = (pid: number): Omit<ServiceRow, "id" | "name" | "port" | "launch"> | null => {
        const chain = ancestors(pid);

        if (chain.some((member) => isSession(processes.get(member)?.command ?? ""))) {
            return null;
        }

        const launchdPid = chain.find((member) => labelOf.has(member));
        // The topmost GenesisTools process under launchd, a terminal, or whatever started it.
        const root =
            launchdPid ??
            [...chain].reverse().find((member) => GENESIS.test(processes.get(member)?.command ?? "")) ??
            pid;
        const rootRow = processes.get(root);
        const pids = subtree(root);
        return {
            pid,
            rootPid: root,
            pids,
            commands: Object.fromEntries(pids.map((member) => [member, processes.get(member)?.command ?? ""])),
            cwd: probe.cwd(root),
            startedAt: rootRow?.startTime?.getTime() ?? null,
            managed: launchdPid === undefined ? "detached" : "launchd",
            label: launchdPid === undefined ? null : (labelOf.get(launchdPid) ?? null),
            command: processes.get(pid)?.command ?? "",
            relaunch: relaunchArgs(
                chain
                    .slice(0, chain.indexOf(root) + 1)
                    .reverse()
                    .map((member) => processes.get(member)?.command ?? "")
            ),
        };
    };

    const rows: ServiceRow[] = [];
    const listeners = probe.listeners();

    for (const entry of listPortRegistry()) {
        const pid = [...listeners.entries()].find(([, ports]) => ports.includes(entry.port))?.[0];

        if (pid === undefined || !matches(entry, pid, processes.get(pid), probe)) {
            continue;
        }

        const described = describe(pid);

        if (described) {
            rows.push({ id: entry.key, name: entry.name, port: entry.port, launch: entry.launch, ...described });
        }
    }

    const covered = new Set(rows.flatMap((row) => row.pids));

    for (const job of jobs) {
        if (job.pid === null || covered.has(job.pid) || !processes.has(job.pid)) {
            continue;
        }

        const described = describe(job.pid);

        if (described) {
            const id = job.label.slice(LAUNCHD_PREFIX.length);
            rows.push({ id, name: id, port: null, launch: null, ...described });
        }
    }

    logger.debug({ services: rows.length }, "services: inventory");
    return rows;
}

function matches(entry: RegistryEntry, pid: number, row: PsRow | undefined, probe: ServiceProbe): boolean {
    if (!row) {
        return false;
    }

    const cwd = probe.cwd(pid) ?? undefined;
    return entry.matchProcess({ port: entry.port, command: row.command, fullCommand: row.command, cwd });
}
