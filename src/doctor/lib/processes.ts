import { type ProcessEntry, listProcesses as readProcessTable } from "@genesiscz/utils/process/processes";
import { batchCwd, processBasename } from "@genesiscz/utils/process/ps";

export interface ProcInfo {
    pid: number;
    ppid?: number;
    command: string;
    startedAt: Date | null;
}

/** Every process on the machine. Throws when the table cannot be read: an empty list would read as "nothing runs"
 *  and silently drop every "quit the app first" blocker. */
export type ProcessLister = () => Promise<ProcInfo[]>;
export type CwdReader = (pids: number[]) => Map<number, string>;

export const PROCESS_LIST_UNAVAILABLE =
    "the process list could not be read, so a running owner cannot be ruled out: try again";

export type ProcessSnapshot = { ok: true; procs: ProcInfo[] } | { ok: false; error: string };

let memo: { at: number; rows: Promise<ProcInfo[]> } | null = null;

/** The kernel table as {@link ProcInfo}. An empty table is a failed read: it must not look like "nothing runs". */
export function toProcInfo(entries: ProcessEntry[]): ProcInfo[] {
    if (entries.length === 0) {
        throw new Error("process table could not be read");
    }

    return entries.map((entry) => ({
        pid: entry.pid,
        ppid: entry.ppid,
        command: entry.command ?? entry.name,
        startedAt: entry.startMs === null ? null : new Date(entry.startMs),
    }));
}

async function readTable(): Promise<ProcInfo[]> {
    return toProcInfo(readProcessTable({ commands: true, otherUsers: true }));
}

/** Every process, from one process-table read, shared by all analyzers of a run for 5 s. A failure is not memoised. */
export async function listProcesses(): Promise<ProcInfo[]> {
    const now = Date.now();

    if (!memo || now - memo.at > 5_000) {
        const rows = readTable();
        memo = { at: now, rows };
        rows.catch(() => {
            memo = null;
        });
    }

    return memo.rows;
}

/** Run a lister and say whether it worked, so a rule can turn a failure into a blocker. */
export async function snapshotProcesses(lister: ProcessLister = listProcesses): Promise<ProcessSnapshot> {
    try {
        const procs = await lister();
        return { ok: true, procs };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export const readCwds: CwdReader = (pids) => batchCwd(pids);

/** This process and its ancestors: a check for "is the app running" must not see the `tools doctor act` call (and
 *  the shell and launcher above it), whose argv names the very paths and ids it is checking. */
export function selfAndAncestors(procs: ProcInfo[]): Set<number> {
    const parentOf = new Map(procs.map((proc) => [proc.pid, proc.ppid]));
    const own = new Set<number>([process.pid]);
    let next: number | undefined = process.ppid;

    while (next !== undefined && next > 1 && !own.has(next)) {
        own.add(next);
        next = parentOf.get(next);
    }

    return own;
}

/** The processes that are not this one or one of its ancestors. */
export function othersOnly(procs: ProcInfo[]): ProcInfo[] {
    const own = selfAndAncestors(procs);
    return procs.filter((proc) => !own.has(proc.pid));
}

/** True when `proc` runs an executable named `name`: an app's `Contents/MacOS/<name>`, or argv[0]'s basename. */
export function runsExecutable(proc: ProcInfo, name: string): boolean {
    const command = proc.command;

    if (command.includes(`/Contents/MacOS/${name} `) || command.endsWith(`/Contents/MacOS/${name}`)) {
        return true;
    }

    return processBasename(command) === name;
}

/** True when the process's executable lives inside `dir` (its argv starts with a path under it). */
export function runsFrom(proc: ProcInfo, dir: string): boolean {
    return proc.command.startsWith(`${dir}/`);
}

export function findRunning(procs: ProcInfo[], names: string[]): ProcInfo[] {
    return othersOnly(procs).filter((proc) => names.some((name) => runsExecutable(proc, name)));
}

export function describeRunning(procs: ProcInfo[]): string {
    return procs
        .slice(0, 3)
        .map((proc) => `pid ${proc.pid}`)
        .join(", ");
}
