/**
 * The data layer behind `tools macos-resources`, with no React and no
 * import-time side effects.
 *
 * It exists so the refresh cycle can be driven, counted and asserted on without
 * a terminal. The previous version kept all of this in closures inside the Ink
 * component, next to a top-level `parseArgs` and `render()`, so importing the
 * module started a TUI and there was nothing to measure.
 *
 * The cost of one cycle is fixed and small: ONE `ps` call for every process on
 * the machine, plus one `lsof` call per 60 pids that are actually due an
 * open-files refresh. Nothing here runs through a shell.
 */

import { logger } from "@genesiscz/utils/logger";
import {
    batchOpenFileCounts as batchOpenFileCountsRaw,
    capture,
    chunk,
    listPsRows,
    PS_BATCH_SIZE,
    type PsListRow,
    processBasename,
} from "@genesiscz/utils/process/ps";

const { log } = logger.scoped("macos-resources");

/** An open-file count that could not be read. Never confuse it with zero. */
export const UNKNOWN_OPEN_FILES = -1;

/** How long a pid's open-file count stays fresh before it is re-read. */
export const OPEN_FILES_TTL_MS = 60_000;

/**
 * Pids at or below this are the kernel and early boot processes. `lsof` answers
 * for almost none of them without root, so asking costs a spawn and returns
 * nothing.
 */
const MIN_INSPECTABLE_PID = 100;

const KB_PER_MB = 1024;
const LSOF_TIMEOUT_MS = 10_000;
const PS_TIMEOUT_MS = 10_000;

export type SortBy = "cpu" | "pid" | "files";

/** The next sort in the `s` key's cycle: cpu → files → pid → cpu. */
export function nextSortBy(current: SortBy): SortBy {
    if (current === "cpu") {
        return "files";
    }

    if (current === "files") {
        return "pid";
    }

    return "cpu";
}

export interface ProcessInfo {
    pid: number;
    /** Basename of argv[0]. */
    name: string;
    cpu: number;
    memoryMB: number;
    /** {@link UNKNOWN_OPEN_FILES} until `lsof` has answered for this pid. */
    openFiles: number;
    command: string;
}

export interface OpenFile {
    fd: string;
    type: string;
    name: string;
}

/** One child process the cycle ran, for the Commands Performance panel. */
export interface CommandTiming {
    command: string;
    durationMs: number;
    at: Date;
}

export interface RefreshState {
    /** Process name or pid to keep. Empty keeps everything. */
    filter: string;
    sortBy: SortBy;
    /** Last cycle's rows, so a known open-file count survives the refresh. */
    previous: readonly ProcessInfo[];
    /** pid → epoch ms when its open-file count was last read. */
    lastFilesUpdate: ReadonlyMap<number, number>;
    /** Always re-read, so the row the user is looking at is never stale. */
    selectedPid: number | null;
    /** Re-read every pid's open-file count, ignoring the TTL. The `r` key. */
    forceFiles?: boolean;
    /** Injectable clock. Defaults to `Date.now()`. */
    now?: number;
    /**
     * Called with the sorted process list the moment `ps` returns, before any
     * `lsof` runs.
     *
     * The TUI paints from this. Without it the first frame would wait for the
     * cold open-files sweep, which reads every process on the machine and takes
     * seconds — the table would sit on "Loading processes..." the whole time.
     */
    onProcesses?: (processes: ProcessInfo[]) => void;
}

export interface RefreshResult {
    processes: ProcessInfo[];
    lastFilesUpdate: Map<number, number>;
    commands: CommandTiming[];
}

/**
 * Does this row survive the `--process` filter?
 *
 * A numeric filter is an exact pid. Anything else is a case-insensitive
 * substring of the name or the full command, which is what `ps aux | grep -i`
 * plus the old in-process check came to between them.
 */
export function matchesFilter(row: { pid: number; name: string; command: string }, filter: string): boolean {
    if (filter === "") {
        return true;
    }

    if (!Number.isNaN(Number(filter))) {
        return row.pid === Number.parseInt(filter, 10);
    }

    const needle = filter.toLowerCase();

    return row.name.toLowerCase().includes(needle) || row.command.toLowerCase().includes(needle);
}

export function sortProcesses(processes: readonly ProcessInfo[], sortBy: SortBy): ProcessInfo[] {
    const copy = [...processes];

    if (sortBy === "files") {
        return copy.sort((a, b) => b.openFiles - a.openFiles);
    }

    if (sortBy === "cpu") {
        return copy.sort((a, b) => b.cpu - a.cpu);
    }

    return copy.sort((a, b) => a.pid - b.pid);
}

/**
 * Turn raw `ps` rows into the table's rows, carrying forward the open-file count
 * a previous cycle already paid for. Without the carry-over every row would
 * flash back to "?" once per refresh and every count would be re-read.
 */
export function toProcessInfos(
    rows: readonly PsListRow[],
    input: { filter: string; previous: readonly ProcessInfo[] }
): ProcessInfo[] {
    const known = new Map<number, number>();

    for (const proc of input.previous) {
        if (proc.openFiles !== UNKNOWN_OPEN_FILES) {
            known.set(proc.pid, proc.openFiles);
        }
    }

    const processes: ProcessInfo[] = [];

    for (const row of rows) {
        const name = processBasename(row.command);

        if (!matchesFilter({ pid: row.pid, name, command: row.command }, input.filter)) {
            continue;
        }

        processes.push({
            pid: row.pid,
            name,
            cpu: row.cpu,
            memoryMB: row.rssKb / KB_PER_MB,
            openFiles: known.get(row.pid) ?? UNKNOWN_OPEN_FILES,
            command: row.command,
        });
    }

    return processes;
}

/**
 * Which pids are due an open-files read this cycle.
 *
 * Three reasons qualify: the pid has never been asked about, it is the selected
 * row (so the number under the cursor is always current), or its TTL expired.
 * Everything else is skipped, which is what keeps a steady-state cycle at two
 * child processes instead of one per row.
 *
 * ⚠️ The trigger is "never asked", NOT "count is still unknown". They look
 * interchangeable and are not: on a shared machine `lsof` refuses several
 * hundred processes belonging to other users, and those rows stay unknown
 * forever. Keying on the count re-asked all of them on every single cycle —
 * measured at 430 pids and 9 spawns per cycle where 1 pid and 2 spawns were
 * intended.
 */
export function planOpenFilesRefresh(input: {
    processes: readonly ProcessInfo[];
    lastFilesUpdate: ReadonlyMap<number, number>;
    selectedPid: number | null;
    now: number;
    force?: boolean;
}): number[] {
    const due: number[] = [];

    for (const proc of input.processes) {
        if (proc.pid <= MIN_INSPECTABLE_PID || proc.name.includes("kernel")) {
            continue;
        }

        const lastUpdate = input.lastFilesUpdate.get(proc.pid);
        const neverAsked = lastUpdate === undefined;
        const stale = lastUpdate !== undefined && input.now - lastUpdate >= OPEN_FILES_TTL_MS;

        if (input.force || neverAsked || proc.pid === input.selectedPid || stale) {
            due.push(proc.pid);
        }
    }

    return due;
}

/**
 * Fold a batch of counts back into the rows.
 *
 * A requested pid that `lsof` did not answer for keeps whatever it had, and its
 * TTL is still stamped — otherwise a process the current user cannot inspect
 * would be re-asked every single cycle, forever.
 */
export function applyOpenFileCounts(
    processes: readonly ProcessInfo[],
    counts: ReadonlyMap<number, number>,
    input: { requested: readonly number[]; lastFilesUpdate: ReadonlyMap<number, number>; now: number }
): { processes: ProcessInfo[]; lastFilesUpdate: Map<number, number> } {
    const lastFilesUpdate = new Map(input.lastFilesUpdate);

    for (const pid of input.requested) {
        lastFilesUpdate.set(pid, input.now);
    }

    const live = new Set(processes.map((proc) => proc.pid));

    for (const pid of lastFilesUpdate.keys()) {
        if (!live.has(pid)) {
            lastFilesUpdate.delete(pid);
        }
    }

    const updated = processes.map((proc) => {
        const count = counts.get(proc.pid);

        if (count === undefined) {
            return proc;
        }

        return { ...proc, openFiles: count };
    });

    return { processes: updated, lastFilesUpdate };
}

/** Every process on the machine that survives `filter`, sorted. ONE `ps` call. */
export async function listProcesses(input: {
    filter: string;
    sortBy: SortBy;
    previous?: readonly ProcessInfo[];
}): Promise<{ processes: ProcessInfo[]; timing: CommandTiming }> {
    const startedAt = Date.now();
    const rows = await listPsRows({ timeoutMs: PS_TIMEOUT_MS });
    const processes = toProcessInfos(rows, { filter: input.filter, previous: input.previous ?? [] });

    return {
        processes: sortProcesses(processes, input.sortBy),
        timing: { command: `ps -axo (${rows.length} rows)`, durationMs: Date.now() - startedAt, at: new Date() },
    };
}

/** Open-file counts for many pids, batched {@link PS_BATCH_SIZE} at a time. */
export async function batchOpenFileCounts(
    pids: readonly number[]
): Promise<{ counts: Map<number, number>; timing: CommandTiming | null }> {
    if (pids.length === 0) {
        return { counts: new Map(), timing: null };
    }

    const startedAt = Date.now();
    const counts = await batchOpenFileCountsRaw([...pids], { timeoutMs: LSOF_TIMEOUT_MS });
    const batches = chunk([...pids], PS_BATCH_SIZE).length;

    return {
        counts,
        timing: {
            command: `lsof -p ×${pids.length} (${batches} ${batches === 1 ? "batch" : "batches"})`,
            durationMs: Date.now() - startedAt,
            at: new Date(),
        },
    };
}

/**
 * One full refresh: the process table, plus the open-file counts that are due.
 *
 * Costs `1 + ceil(due / 60)` child processes. In steady state `due` is just the
 * selected pid, so a cycle is two spawns however many processes are on screen.
 */
export async function runRefreshCycle(state: RefreshState): Promise<RefreshResult> {
    const now = state.now ?? Date.now();
    const listed = await listProcesses({ filter: state.filter, sortBy: state.sortBy, previous: state.previous });
    state.onProcesses?.(listed.processes);
    const due = planOpenFilesRefresh({
        processes: listed.processes,
        lastFilesUpdate: state.lastFilesUpdate,
        selectedPid: state.selectedPid,
        now,
        force: state.forceFiles,
    });
    const files = await batchOpenFileCounts(due);
    const applied = applyOpenFileCounts(listed.processes, files.counts, {
        requested: due,
        lastFilesUpdate: state.lastFilesUpdate,
        now,
    });
    const commands = files.timing === null ? [listed.timing] : [listed.timing, files.timing];

    log.debug({ processes: applied.processes.length, filesRefreshed: due.length }, "refresh cycle finished");

    return {
        processes: sortProcesses(applied.processes, state.sortBy),
        lastFilesUpdate: applied.lastFilesUpdate,
        commands,
    };
}

/** Parse the column output of a plain `lsof -p <pid>`. */
export function parseOpenFiles(stdout: string): OpenFile[] {
    const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "");

    if (lines.length <= 1) {
        return [];
    }

    const files: OpenFile[] = [];

    for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);

        if (parts.length < 9) {
            continue;
        }

        files.push({ fd: parts[3], type: parts[4], name: parts.slice(8).join(" ") });
    }

    return files.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type.localeCompare(b.type);
        }

        return a.name.localeCompare(b.name);
    });
}

/**
 * The full open-file listing for one pid, for the `f` view. One child process.
 *
 * `-w` replaces the old `2>/dev/null`: warnings about pids the user cannot
 * inspect are suppressed, but a real failure still reaches stderr and is logged
 * instead of being thrown away.
 */
export async function listOpenFiles(pid: number): Promise<{ files: OpenFile[]; timing: CommandTiming }> {
    const startedAt = Date.now();
    let stdout = "";

    try {
        const result = await capture("lsof", ["-w", "-p", String(pid)], { timeoutMs: LSOF_TIMEOUT_MS });
        stdout = result.stdout;

        if (result.stderr.trim() !== "") {
            log.debug({ pid, stderr: result.stderr.trim() }, "lsof reported on stderr while listing open files");
        }
    } catch (err) {
        log.warn({ err, pid }, "lsof could not be spawned for the open-files view");
    }

    return {
        files: parseOpenFiles(stdout),
        timing: { command: `lsof -p ${pid}`, durationMs: Date.now() - startedAt, at: new Date() },
    };
}
