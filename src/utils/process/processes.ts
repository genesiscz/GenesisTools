/**
 * The one place GenesisTools asks the OS about processes; sockets are in `sockets.ts`, open files in
 * `process-files.ts`, and the dependency-free subset in `process-basics.ts`. Every function picks the cheapest
 * complete reader the platform has, so a caller never branches on the platform and never spawns `ps`, `lsof` or
 * `pgrep` itself (lint rule `no-process-tool-spawn`):
 *
 * - macOS: the kernel through `bun:ffi` (`libproc-table.ts`, `socket-owner.ts`, `cwd.ts`). The whole table costs about
 *   1 ms of CPU where one `ps -axo` cost 68 ms. Two things only the setuid `ps` may read: another user's command line,
 *   and another user's CPU and memory. The `otherUsers` options fetch exactly those rows with ONE batched `ps`.
 * - Linux: `/proc` (`linux-proc.ts`), which shows every user's command line and usage.
 * - Windows: one PowerShell CIM query and `netstat -ano` (`windows-cim.ts`).
 * - Where the kernel read is unavailable (the libproc self-check failed, or another platform): one `ps` or `lsof`.
 *
 * Nothing here throws for a process that is gone or unreadable: a reader answers null, a list leaves it out.
 */

import { CString, type Pointer, read } from "bun:ffi";
import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename } from "node:path";
import { libSystem } from "@genesiscz/utils/fs/native/libsystem";
import { ownLineage } from "./cwd";
import {
    listChildPids,
    listProcessTable,
    listTtyTable,
    type ProcessTableRow,
    readProcessUsage as readLibprocUsage,
    readProcessArgs,
    readProcessPath,
    readProcessRow,
    readPsCommand,
} from "./libproc-table";
import { type LinuxProcess, listProcProcesses, readProcEnviron, readProcExe, readProcProcess } from "./linux-proc";
import { darwinKernel, processPlatform } from "./os";
import { captureSync, PS_BATCH_SIZE, parseCpuTime } from "./ps";
import { type CimProcess, listCimProcesses } from "./windows-cim";

export interface ProcessEntry {
    pid: number;
    ppid: number;
    /** Process group; null on Windows. */
    pgid: number | null;
    /** Effective uid; null on Windows. */
    uid: number | null;
    /**
     * The kernel's name: macOS `p_comm` (cut at 16 bytes), Linux comm (cut at 15), Windows image name.
     * {@link findProcesses} completes a cut name before it compares.
     */
    name: string;
    /** The command line as `ps -o command=` prints it; null when not asked for or withheld (see `otherUsers`). */
    command: string | null;
    /** The terminal as `ps -o tty=` prints it (`ttys003`, `pts/2`); null for none. */
    tty: string | null;
    /** Start time in epoch ms; null when unknown. */
    startMs: number | null;
    zombie: boolean;
    /**
     * The first letter of `ps -o state=`: S, T, Z, and R on Linux. macOS reads every live process as S (see
     * `readProcessUsages`' `running`); Windows reads "?".
     */
    state: string;
}

export interface ProcessUsageEntry {
    pid: number;
    rssBytes: number;
    /** User plus system CPU time since the process started. */
    cpuTimeMs: number;
    /** Null where the platform cannot count them cheaply (another user's process on macOS). */
    threads: number | null;
    /** A thread is on a CPU (`ps` state R); null where unknown (another user's process on macOS, Windows). */
    running: boolean | null;
}

export interface ListProcessesOptions {
    /** Read each command line (one kernel read per process). Default true. */
    commands?: boolean;
    /**
     * Also read the command lines macOS withholds from this user (other users' processes): ONE batched `ps` for
     * exactly those rows. Off by default; on other platforms every command line is readable anyway.
     */
    otherUsers?: boolean;
}

export interface ProcessMatch {
    /** Exact short name, as `pgrep -x <name>` compares it. */
    name?: string;
    /** A substring or pattern of the command line, as `pgrep -f`. */
    command?: string | RegExp;
    uid?: number;
    /** See {@link ListProcessesOptions.otherUsers}; only matters with `command`. */
    otherUsers?: boolean;
    /** Also match this process and its ancestors, which `pgrep` leaves out (so a `-f` pattern never finds its caller). */
    includeAncestors?: boolean;
}

const ownUid = (): number => process.geteuid?.() ?? -1;

function fromDarwinRow(row: ProcessTableRow, command: string | null): ProcessEntry {
    return {
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        uid: row.uid,
        name: row.comm,
        command,
        tty: row.tty,
        startMs: row.startMs,
        zombie: row.zombie,
        state: row.state,
    };
}

/** `ps` prints a kernel thread or a process with an empty argv as `[comm]`. */
function linuxCommand(process: LinuxProcess): string {
    return process.argv.length > 0 ? process.argv.join(" ") : `[${process.comm}]`;
}

function fromLinux(process: LinuxProcess, commands: boolean): ProcessEntry {
    return {
        pid: process.pid,
        ppid: process.ppid,
        pgid: process.pgid,
        uid: process.uid,
        name: process.comm,
        command: commands ? linuxCommand(process) : null,
        tty: process.tty,
        startMs: process.startMs,
        zombie: process.state === "Z",
        state: process.state,
    };
}

function fromCim(process: CimProcess, commands: boolean): ProcessEntry {
    return {
        pid: process.pid,
        ppid: process.ppid ?? 0,
        pgid: null,
        uid: null,
        name: process.name,
        command: commands ? (process.command ?? process.name) : null,
        tty: null,
        startMs: process.startMs,
        zombie: false,
        state: "?",
    };
}

/**
 * ONE `ps` for the rows of `pids`, however many: `-p` for up to {@link PS_BATCH_SIZE} pids, the whole table filtered
 * for more (macOS has about 400 other-user processes, and one `ps -A` costs about what one `ps -p` does). `columns`
 * starts with `pid=`; each kept line is the text after the pid.
 */
function psLinesFor(pids: number[], columns: string): Map<number, string> {
    const lines = new Map<number, string>();

    if (pids.length === 0) {
        return lines;
    }

    const wanted = new Set(pids);
    const args = pids.length <= PS_BATCH_SIZE ? ["-o", columns, "-p", pids.join(",")] : ["-A", "-o", columns];

    for (const line of captureSync("ps", args).stdout.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);

        if (match && wanted.has(Number(match[1]))) {
            lines.set(Number(match[1]), match[2]);
        }
    }

    return lines;
}

/** The command lines of `pids` from one `ps`: what macOS withholds from libproc for other users. */
function psCommands(pids: number[]): Map<number, string> {
    return new Map([...psLinesFor(pids, "pid=,command=")].map(([pid, rest]) => [pid, rest.trimEnd()]));
}

/** `rss= time=` (KB and `ps` CPU time) as a usage entry; null when the line does not parse. */
function psUsage(pid: number, rssKb: string, time: string): ProcessUsageEntry | null {
    const cpuTimeMs = parseCpuTime(time);
    const rss = Number(rssKb);

    if (cpuTimeMs === null || !Number.isFinite(rss)) {
        return null;
    }

    return { pid, rssBytes: rss * 1024, cpuTimeMs, threads: null, running: null };
}

/** `lstart` as `ps` prints it: `Tue Oct 13 15:32:57 2026`, local time. */
function parseLstart(text: string): number | null {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
}

const PS_FALLBACK_COLUMNS = "pid=,ppid=,pgid=,uid=,tty=,state=,lstart=,comm=";

/** The whole table from one `ps`, where no kernel reader works. */
function psTable(commands: boolean): ProcessEntry[] {
    const entries = parseFallbackPsTable(captureSync("ps", ["-axo", PS_FALLBACK_COLUMNS]).stdout);

    if (commands) {
        const lines = psCommands(entries.map((entry) => entry.pid));

        for (const entry of entries) {
            entry.command = lines.get(entry.pid) ?? null;
        }
    }

    return entries;
}

/** `ps -axo pid=,ppid=,pgid=,uid=,tty=,state=,lstart=,comm=` as entries without a command. */
export function parseFallbackPsTable(stdout: string): ProcessEntry[] {
    const entries: ProcessEntry[] = [];

    for (const line of stdout.split("\n")) {
        // pid ppid pgid uid tty state, then lstart (5 words), then comm (a path that may hold spaces).
        const match = line.match(
            /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/
        );

        if (!match) {
            continue;
        }

        entries.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            uid: Number(match[4]),
            name: basename(match[8].trim()),
            command: null,
            tty: match[5] === "??" || match[5] === "?" ? null : match[5],
            startMs: parseLstart(match[7]),
            zombie: match[6].startsWith("Z"),
            state: match[6].slice(0, 1),
        });
    }

    return entries;
}

/** Every process on the machine. */
export function listProcesses(options: ListProcessesOptions = {}): ProcessEntry[] {
    const commands = options.commands !== false;

    switch (processPlatform()) {
        case "linux":
            return listProcProcesses().map((process) => fromLinux(process, commands));
        case "win32":
            return listCimProcesses().map((process) => fromCim(process, commands));
        default:
            break;
    }

    const rows = darwinKernel() ? listProcessTable() : null;

    if (rows === null) {
        return psTable(commands);
    }

    const uid = ownUid();
    const entries = rows.map((row) =>
        fromDarwinRow(row, commands && (row.uid === uid || uid === 0) && !row.zombie ? readPsCommand(row.pid) : null)
    );

    if (commands && options.otherUsers) {
        const withheld = entries.filter((entry) => entry.command === null && !entry.zombie).map((entry) => entry.pid);
        const lines = withheld.length > 0 ? psCommands(withheld) : new Map<number, string>();

        for (const entry of entries) {
            entry.command ??= lines.get(entry.pid) ?? null;
        }
    }

    return entries;
}

/** One process, or null when it is gone. */
export function readProcess(pid: number, options: Pick<ListProcessesOptions, "otherUsers"> = {}): ProcessEntry | null {
    if (!Number.isInteger(pid) || pid < 0) {
        return null;
    }

    switch (processPlatform()) {
        case "linux": {
            const process = readProcProcess(pid);
            return process ? fromLinux(process, true) : null;
        }
        case "win32": {
            const [process] = listCimProcesses(pid);
            return process ? fromCim(process, true) : null;
        }
        default:
            break;
    }

    if (!darwinKernel()) {
        const [entry] = parseFallbackPsTable(captureSync("ps", ["-o", PS_FALLBACK_COLUMNS, "-p", String(pid)]).stdout);
        return entry ? { ...entry, command: psCommands([pid]).get(pid) ?? null } : null;
    }

    const row = readProcessRow(pid);

    if (!row) {
        return null;
    }

    const command = row.zombie ? null : readPsCommand(pid);
    return fromDarwinRow(row, command ?? (options.otherUsers ? (psCommands([pid]).get(pid) ?? null) : null));
}

/** The direct children of `pid`, ascending (`pgrep -P`). */
export function childPids(pid: number): number[] {
    const fromKernel = darwinKernel() ? listChildPids(pid) : null;

    if (fromKernel) {
        return fromKernel.filter((child) => child !== pid).sort((a, b) => a - b);
    }

    return listProcesses({ commands: false })
        .filter((entry) => entry.ppid === pid && entry.pid !== pid)
        .map((entry) => entry.pid)
        .sort((a, b) => a - b);
}

/** Every descendant of `pid`, breadth first. */
export function descendantPids(pid: number): number[] {
    const found: number[] = [];
    const seen = new Set([pid]);
    // macOS: one kernel call per process in the tree, which is a handful. Elsewhere, or without libproc: the table once.
    let queue = darwinKernel() ? listChildPids(pid) : null;
    const childrenOf = queue !== null ? (parent: number) => listChildPids(parent) ?? [] : tableChildren();
    queue ??= childrenOf(pid);

    while (queue.length > 0) {
        const next: number[] = [];

        for (const child of queue) {
            if (!seen.has(child)) {
                seen.add(child);
                found.push(child);
                next.push(...childrenOf(child));
            }
        }

        queue = next;
    }

    return found;
}

function tableChildren(): (parent: number) => number[] {
    const byParent = new Map<number, number[]>();

    for (const entry of listProcesses({ commands: false })) {
        byParent.set(entry.ppid, [...(byParent.get(entry.ppid) ?? []), entry.pid]);
    }

    return (parent) => byParent.get(parent) ?? [];
}

/** `pid`, its parent, its grandparent, … up to `maxDepth` or the root, each with its command when readable. */
export function ancestry(pid: number, maxDepth = 64): ProcessEntry[] {
    const chain: ProcessEntry[] = [];
    const seen = new Set<number>();
    let current: number | null = pid;

    while (current !== null && current > 0 && !seen.has(current) && chain.length < maxDepth) {
        seen.add(current);
        const entry = readProcess(current);

        if (!entry) {
            break;
        }

        chain.push(entry);
        current = entry.ppid;
    }

    return chain;
}

/** The longest name the kernel keeps: 16 bytes on macOS (`p_comm`), 15 on Linux (`comm`). Windows keeps the whole. */
function kernelNameLength(): number {
    return processPlatform() === "linux" ? 15 : processPlatform() === "win32" ? Number.POSITIVE_INFINITY : 16;
}

/**
 * The whole name of a process whose kernel name may be cut: the basename of `argv[0]` (this user's processes), else
 * of the executable path (any user's). So "Brave Browser Nightly" matches although `p_comm` holds "Brave Browser Ni".
 * On Linux this also fixes procps, whose `pgrep -x google-chrome-stable` can never match.
 */
function fullName(entry: ProcessEntry): string {
    if (processPlatform() === "linux") {
        const process = readProcProcess(entry.pid);
        const path = process?.argv[0] ?? readProcExe(entry.pid);
        return path ? basename(path) : entry.name;
    }

    const path = readProcessArgs(entry.pid)?.argv[0] ?? readProcessPath(entry.pid);
    return path ? basename(path) : entry.name;
}

function nameMatches(entry: ProcessEntry, name: string): boolean {
    if (entry.name.length < kernelNameLength()) {
        return entry.name === name;
    }

    // A full-length kernel name may be a cut ("Brave Browser He"), so it never matches on its own: the whole name must.
    return name.startsWith(entry.name) && fullName(entry) === name;
}

/**
 * Processes matching every given field, ascending by pid: `pgrep -x <name>`, `pgrep -f <pattern>`, `-U <uid>`. Like
 * `pgrep`, it leaves out this process and its ancestors unless `includeAncestors`. Checked against macOS `pgrep -x` on
 * 2026-10-14: 608 of 613 names equal. The rest: processes that rewrote `argv[0]` (`claude bg-pty-host`, the login
 * shell `-zsh`), which `pgrep` compares by that text and this by the kernel name; a 48-byte name, which `pgrep` never
 * matches; and launchd, which `pgrep` counts as everyone's ancestor.
 */
export function findProcesses(match: ProcessMatch): ProcessEntry[] {
    const wantsCommand = match.command !== undefined;
    const name = match.name;
    const lineage = match.includeAncestors ? new Set<number>() : ownLineage();
    const pattern = typeof match.command === "string" ? undefined : match.command;
    const needle = typeof match.command === "string" ? match.command : undefined;

    return listProcesses({ commands: wantsCommand, otherUsers: match.otherUsers })
        .filter((entry) => {
            if (entry.zombie || lineage.has(entry.pid)) {
                return false;
            }

            if (name !== undefined && !nameMatches(entry, name)) {
                return false;
            }

            if (match.uid !== undefined && entry.uid !== match.uid) {
                return false;
            }

            if (needle !== undefined && !entry.command?.includes(needle)) {
                return false;
            }

            return pattern === undefined || pattern.test(entry.command ?? "");
        })
        .sort((a, b) => a.pid - b.pid);
}

/** The processes on terminal `tty` (`ps -t`); accepts `ttys003`, `s003`, `/dev/ttys003` or `pts/2`. */
export function processesOnTty(tty: string): ProcessEntry[] {
    const bare = tty.replace(/^\/dev\//, "");
    const wanted = new Set([bare, bare.startsWith("tty") ? bare.slice(3) : `tty${bare}`]);
    const rows = darwinKernel() ? ttyRows(bare) : null;

    if (rows) {
        return rows.map((row) => fromDarwinRow(row, readPsCommand(row.pid)));
    }

    // The table first and the command lines of the few processes on the terminal after, not of every process.
    return listProcesses({ commands: false })
        .filter((entry) => entry.tty !== null && wanted.has(entry.tty))
        .map((entry) => readProcess(entry.pid) ?? entry);
}

/** The kernel's rows for terminal `bare` (`ttys003` or `s003`); null when the device or the read is not there. */
function ttyRows(bare: string): ProcessTableRow[] | null {
    try {
        return listTtyTable(statSync(`/dev/${bare.startsWith("tty") ? bare : `tty${bare}`}`).rdev);
    } catch {
        return null;
    }
}

/**
 * Which of `names` have a running process, from one table read: `pgrep -x` per name without the spawns (18 browser
 * names cost 18 `pgrep` processes). Same name rule and ancestor exclusion as {@link findProcesses}.
 */
export function runningNames(names: string[]): Set<string> {
    const lineage = ownLineage();
    const running = new Set<string>();

    for (const entry of listProcesses({ commands: false })) {
        if (entry.zombie || lineage.has(entry.pid)) {
            continue;
        }

        for (const name of names) {
            if (!running.has(name) && nameMatches(entry, name)) {
                running.add(name);
            }
        }
    }

    return running;
}

/** `KEY=value` pairs of the process environment; null when withheld (another user's process, Windows). */
export function readProcessEnvironment(pid: number): Record<string, string> | null {
    const pairs =
        processPlatform() === "linux"
            ? readProcEnviron(pid)
            : darwinKernel()
              ? (readProcessArgs(pid, { env: true })?.env ?? null)
              : null;

    if (pairs === null) {
        return null;
    }

    const environment: Record<string, string> = {};

    for (const pair of pairs) {
        const equals = pair.indexOf("=");

        if (equals > 0) {
            environment[pair.slice(0, equals)] = pair.slice(equals + 1);
        }
    }

    return environment;
}

/** The executable's path (the image name on Windows); null when the process is gone or the OS withholds it. */
export function readExecutablePath(pid: number): string | null {
    switch (processPlatform()) {
        case "linux":
            return readProcExe(pid) ?? readProcProcess(pid)?.comm ?? null;
        case "win32":
            return listCimProcesses(pid)[0]?.executable ?? null;
        default:
            break;
    }

    if (darwinKernel()) {
        return readProcessPath(pid);
    }

    const result = captureSync("ps", ["-o", "comm=", "-p", String(pid)]);
    return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * CPU, memory and thread count of each pid. On macOS the kernel answers for this user's processes; with
 * `otherUsers` the rest come from ONE batched `ps` (without a thread count). A pid that is gone is absent.
 */
export function readProcessUsages(
    pids: number[],
    options: Pick<ListProcessesOptions, "otherUsers"> = {}
): Map<number, ProcessUsageEntry> {
    const usages = new Map<number, ProcessUsageEntry>();

    switch (processPlatform()) {
        case "linux":
            for (const pid of pids) {
                const process = readProcProcess(pid);

                if (process) {
                    usages.set(pid, {
                        pid,
                        rssBytes: process.rssBytes,
                        cpuTimeMs: process.cpuTimeMs,
                        threads: process.threads,
                        running: process.state === "R",
                    });
                }
            }

            return usages;
        case "win32": {
            const wanted = new Set(pids);

            for (const process of listCimProcesses()) {
                if (wanted.has(process.pid)) {
                    usages.set(process.pid, {
                        pid: process.pid,
                        rssBytes: process.rssBytes ?? 0,
                        cpuTimeMs: process.cpuTimeMs ?? 0,
                        threads: process.threads,
                        running: null,
                    });
                }
            }

            return usages;
        }
        default:
            break;
    }

    const missing: number[] = [];

    for (const pid of pids) {
        const usage = darwinKernel() ? readLibprocUsage(pid) : null;

        if (usage) {
            usages.set(pid, { pid, ...usage });
        } else {
            missing.push(pid);
        }
    }

    if (options.otherUsers || !darwinKernel()) {
        for (const [pid, rest] of psLinesFor(missing, "pid=,rss=,time=")) {
            const [rssKb = "", time = ""] = rest.trim().split(/\s+/);
            const usage = psUsage(pid, rssKb, time);

            if (usage) {
                usages.set(pid, usage);
            }
        }
    }

    return usages;
}

export interface ProcessWithUsage extends ProcessEntry {
    /** Null for another user's process on macOS without `otherUsers`. */
    usage: ProcessUsageEntry | null;
}

/**
 * Every process with its command line and usage: `ps -axo pid,ppid,user,state,pcpu,rss,lstart,command` without the
 * spawn. On macOS, `otherUsers` fills in what the kernel withholds from this user (another user's command line,
 * memory and CPU time) with ONE batched `ps`, never one per question. `commands: false` leaves every command line
 * null, for a caller that names a process by its executable: the `ps` then skips its most expensive column (about
 * 25 ms instead of 55 on 1,300 processes).
 */
export function listProcessesWithUsage(
    options: Pick<ListProcessesOptions, "otherUsers" | "commands"> = {}
): ProcessWithUsage[] {
    const commands = options.commands !== false;
    const fillFromPs = options.otherUsers === true && processPlatform() !== "linux" && processPlatform() !== "win32";
    // The `ps` that fills other users' rows prints every command line anyway, so reading them from the kernel first
    // would read each one twice (about 10 ms of sysctls on 1,300 processes).
    const entries = listProcesses({ commands: commands && !fillFromPs });
    const usages = readProcessUsages(entries.map((entry) => entry.pid));

    if (fillFromPs) {
        const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
        const missing = entries.filter((entry) => !entry.zombie && (commands || !usages.has(entry.pid)));

        for (const [pid, rest] of psLinesFor(
            missing.map((entry) => entry.pid),
            commands ? "pid=,rss=,time=,command=" : "pid=,rss=,time="
        )) {
            const match = rest.match(commands ? /^(\d+)\s+(\S+)\s(.*)$/ : /^(\d+)\s+(\S+)\s*$/);

            if (!match) {
                continue;
            }

            const entry = byPid.get(pid);

            if (entry && commands) {
                entry.command ??= match[3].trimEnd();
            }

            const usage = usages.has(pid) ? null : psUsage(pid, match[1], match[2]);

            if (usage) {
                usages.set(pid, usage);
            }
        }
    }

    return entries.map((entry) => ({ ...entry, usage: usages.get(entry.pid) ?? null }));
}

const userNames = new Map<number, string | null>();

/** The login name of `uid`, as `ps -o user=` prints it; null when the system has none (Windows, an unknown uid). */
export function userName(uid: number): string | null {
    const cached = userNames.get(uid);

    if (cached !== undefined) {
        return cached;
    }

    let name: string | null = null;
    const own = userInfo();

    if (uid === own.uid) {
        name = own.username;
    } else if (processPlatform() === "darwin") {
        const entry = libSystem()?.getpwuid(uid);
        // `pw_name` is the first field of `struct passwd`: the pointer stored there, then the string it points to.
        const field = entry ? read.ptr(entry, 0) : 0;
        name = field ? new CString(field as Pointer).toString() : null;
    } else if (processPlatform() === "linux") {
        name = parsePasswd(readPasswd()).get(uid) ?? null;
    }

    userNames.set(uid, name);
    return name;
}

function readPasswd(): string {
    try {
        return readFileSync("/etc/passwd", "utf8");
    } catch {
        return "";
    }
}

/** uid to name from an `/etc/passwd` body (`name:x:uid:gid:…`). */
export function parsePasswd(body: string): Map<number, string> {
    const names = new Map<number, string>();

    for (const line of body.split("\n")) {
        const [name, , uid] = line.split(":");

        if (name && uid !== undefined && /^\d+$/.test(uid) && !names.has(Number(uid))) {
            names.set(Number(uid), name);
        }
    }

    return names;
}

export { formatLstart, systemTimeZone } from "./process-basics";
