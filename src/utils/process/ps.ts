/**
 * Batched `ps` and `lsof` access.
 *
 * Everything here exists to answer a question about MANY pids with ONE child
 * process. The per-pid shape (`ps -p <pid>` in a loop, `lsof -p <pid> | wc -l`
 * per row) is the pattern this module replaces: it costs one fork per pid per
 * refresh, and through `node:child_process.exec` it costs three, because a
 * shell pipeline forks `/bin/sh` and every stage of the pipe as well.
 *
 * Nothing here uses a shell. Arguments go straight to the binary, so a process
 * name carrying a quote or a `$` cannot become shell syntax.
 *
 * POSIX only. `ps` and `lsof` do not exist on Windows; callers that may run
 * there check the platform themselves (see `src/port/lib/scanner.ts`).
 */

import { spawnSync } from "node:child_process";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("process-ps");

/**
 * How many pids go into one `ps -p` / `lsof -p` comma list.
 *
 * `ARG_MAX` is in the megabytes on macOS, so this is not about the argument
 * limit. It bounds how much work a single child does, so one unresponsive pid
 * cannot stall the whole refresh.
 */
export const PS_BATCH_SIZE = 60;

/** Columns `batchPsInfo` requests. Order must match {@link PS_OUTPUT_PATTERN}. */
export const PS_COLUMNS_SPEC = "pid=,ppid=,user=,state=,pcpu=,rss=,lstart=,command=";

/** Columns {@link listPsRows} requests: pid, %cpu, rss in KB, then the full argv. */
export const PS_LIST_COLUMNS_SPEC = "pid=,pcpu=,rss=,command=";

// ps output columns: PID PPID USER STAT %CPU RSS TTY LSTART COMMAND
const PS_OUTPUT_PATTERN =
    /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+\w+\s+(\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;

const PS_LIST_PATTERN = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;

export interface CaptureResult {
    stdout: string;
    stderr: string;
    /** Exit code, or null when the child was killed or never reported one. */
    status: number | null;
}

/** One row of {@link PS_COLUMNS_SPEC}. `rss` is in kilobytes, as `ps` reports it. */
export interface PsRow {
    pid: number;
    ppid: number;
    user: string;
    stat: string;
    cpu: number;
    rss: number;
    startTime: Date | null;
    command: string;
}

/** One row of {@link PS_LIST_COLUMNS_SPEC}. */
export interface PsListRow {
    pid: number;
    /** `%cpu`, as `ps` reports it: a decayed average over the process's life, not an instant rate. */
    cpu: number;
    rssKb: number;
    /** The full argv, space-joined. */
    command: string;
}

/** Split a list into fixed-size batches. The last batch may be short. */
export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }

    return chunks;
}

/** Run a binary with an argv and capture both streams. No shell, so no quoting hazard. */
export function captureSync(command: string, args: string[], options?: { timeoutMs?: number }): CaptureResult {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options?.timeoutMs,
    });

    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
    };
}

/**
 * Async {@link captureSync}. Use this one from anything with a render loop: a
 * synchronous `ps -axo` over a thousand processes blocks the event loop for as
 * long as it takes, and an Ink app cannot paint or read a keypress meanwhile.
 *
 * `timeoutMs` kills the child rather than waiting forever, because `lsof` can
 * block indefinitely on an unresponsive mount.
 */
export async function capture(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<CaptureResult> {
    const proc = Bun.spawn([command, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd: options?.cwd,
        env: options?.env,
    });
    const timeoutMs = options?.timeoutMs;
    const streams = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    void streams.catch(() => {});

    if (timeoutMs === undefined) {
        const [stdout, stderr] = await streams;
        await proc.exited;

        return { stdout, stderr, status: proc.exitCode };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(true), timeoutMs);
        void proc.exited.then(() => resolve(false));
    });

    if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
    }

    if (timedOut) {
        proc.kill("SIGKILL");
        log.warn({ command, args, timeoutMs }, "child was killed on timeout; its output is partial");

        return { stdout: "", stderr: "", status: null };
    }

    const [stdout, stderr] = await streams;

    return { stdout, stderr, status: proc.exitCode };
}

/**
 * Parse a POSIX `ps -o time` / `cputime` cell into milliseconds.
 *
 * macOS prints `mm:ss.cc` (and `hh:mm:ss` past an hour), Linux prints
 * `[[dd-]hh:]mm:ss`, and both use a leading `dd-` for multi-day processes.
 * Returns null for anything it does not recognise, so a caller can tell a
 * parse failure apart from a genuine zero.
 */
export function parseCpuTime(raw: string): number | null {
    const text = raw.trim();

    if (text.length === 0) {
        return null;
    }

    const dashIndex = text.indexOf("-");
    let days = 0;
    let rest = text;

    if (dashIndex > 0) {
        days = Number(text.slice(0, dashIndex));
        rest = text.slice(dashIndex + 1);
    }

    if (!Number.isFinite(days)) {
        return null;
    }

    const parts = rest.split(":");

    if (parts.length > 3) {
        return null;
    }

    let seconds = 0;

    for (const part of parts) {
        const value = Number(part);

        if (!Number.isFinite(value)) {
            return null;
        }

        seconds = seconds * 60 + value;
    }

    return Math.round((days * 86_400 + seconds) * 1000);
}

export function parsePsLine(line: string): PsRow | null {
    const match = line.trim().match(PS_OUTPUT_PATTERN);

    if (!match) {
        return null;
    }

    const startTime = new Date(match[7]);

    return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        user: match[3],
        stat: match[4],
        cpu: Number.parseFloat(match[5]),
        rss: Number.parseInt(match[6], 10),
        startTime: Number.isNaN(startTime.getTime()) ? null : startTime,
        command: match[8],
    };
}

/** One `ps -p <batch>` per {@link PS_BATCH_SIZE} pids. Pids that are gone are simply absent. */
export function batchPsInfo(pids: number[]): Map<number, PsRow> {
    const rows = new Map<number, PsRow>();

    for (const batch of chunk(pids, PS_BATCH_SIZE)) {
        const result = captureSync("ps", ["-p", batch.join(","), "-o", PS_COLUMNS_SPEC]);

        for (const line of result.stdout.split("\n")) {
            if (line.trim() === "") {
                continue;
            }

            const parsed = parsePsLine(line);

            if (!parsed) {
                continue;
            }

            rows.set(parsed.pid, parsed);
        }
    }

    return rows;
}

/** One `lsof -a -d cwd -p <batch>` per {@link PS_BATCH_SIZE} pids. */
export function batchCwd(pids: number[]): Map<number, string> {
    const values = new Map<number, string>();

    for (const batch of chunk(pids, PS_BATCH_SIZE)) {
        const result = captureSync("lsof", ["-a", "-d", "cwd", "-p", batch.join(",")]);
        const lines = result.stdout.split("\n").slice(1);

        for (const line of lines) {
            if (line.trim() === "") {
                continue;
            }

            const parts = line.trim().split(/\s+/);

            if (parts.length < 9) {
                continue;
            }

            const pid = Number.parseInt(parts[1], 10);
            const cwd = parts.slice(8).join(" ");

            if (Number.isNaN(pid) || !cwd.startsWith("/")) {
                continue;
            }

            values.set(pid, cwd);
        }
    }

    return values;
}

/** Parse the stdout of `ps -axo pid=,pcpu=,rss=,command=`. Unparseable lines are skipped. */
export function parsePsList(stdout: string): PsListRow[] {
    const rows: PsListRow[] = [];

    for (const raw of stdout.split("\n")) {
        const match = raw.match(PS_LIST_PATTERN);

        if (match === null) {
            continue;
        }

        const pid = Number.parseInt(match[1], 10);
        const cpu = Number.parseFloat(match[2]);
        const rssKb = Number.parseInt(match[3], 10);

        if (Number.isNaN(pid) || Number.isNaN(rssKb)) {
            continue;
        }

        rows.push({ pid, cpu: Number.isNaN(cpu) ? 0 : cpu, rssKb, command: match[4].trim() });
    }

    return rows;
}

/**
 * Every process on the machine, in ONE `ps` call.
 *
 * Returns an empty list when `ps` cannot be reached, and logs why. A caller that
 * needs to tell "nothing is running" apart from "ps failed" should read the log
 * line; in practice an empty process table is impossible on a live machine, so
 * an empty result already means the call failed.
 */
export async function listPsRows(options?: { timeoutMs?: number }): Promise<PsListRow[]> {
    try {
        const result = await capture("ps", ["-axo", PS_LIST_COLUMNS_SPEC], options);

        if (result.status !== 0) {
            log.warn({ status: result.status, stderr: result.stderr.trim() }, "ps -axo did not exit cleanly");
        }

        return parsePsList(result.stdout);
    } catch (err) {
        log.warn({ err }, "ps -axo could not be spawned");
        return [];
    }
}

/**
 * Parse `lsof -Fpf` field output into a per-pid count of open file entries.
 *
 * The field format prints one `p<pid>` line per process followed by one `f<fd>`
 * line per open entry, so counting `f` lines inside each `p` section gives the
 * same number as `lsof -p <pid> | wc -l` minus its header row. Verified on
 * 2026-09-16 against a live pid: 9 body lines, 8 `f` records.
 */
export function parseOpenFileCounts(stdout: string): Map<number, number> {
    const counts = new Map<number, number>();
    let current: number | null = null;

    for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
            const pid = Number.parseInt(line.slice(1), 10);
            current = Number.isNaN(pid) ? null : pid;

            if (current !== null && !counts.has(current)) {
                counts.set(current, 0);
            }

            continue;
        }

        if (line.startsWith("f") && current !== null) {
            counts.set(current, (counts.get(current) ?? 0) + 1);
        }
    }

    return counts;
}

/**
 * How many files each pid holds open, one `lsof` per {@link PS_BATCH_SIZE} pids.
 *
 * A pid missing from the result is a pid `lsof` could not report on — dead, or
 * owned by another user without root. That is NOT the same as zero, so the
 * caller must keep the two apart rather than defaulting a miss to 0.
 *
 * `-n` and `-P` skip DNS and port-name lookups, which are the slow part of a
 * plain `lsof` on a machine with network sockets open.
 */
export async function batchOpenFileCounts(
    pids: number[],
    options?: { timeoutMs?: number }
): Promise<Map<number, number>> {
    const counts = new Map<number, number>();

    for (const batch of chunk(pids, PS_BATCH_SIZE)) {
        try {
            const result = await capture("lsof", ["-n", "-P", "-w", "-Fpf", "-p", batch.join(",")], options);

            // lsof exits 1 when any listed pid matched nothing, which is the normal
            // case for a batch containing a process that just died.
            if (result.status !== 0 && result.status !== 1) {
                log.debug(
                    { status: result.status, stderr: result.stderr.trim(), pids: batch.length },
                    "lsof batch did not exit cleanly; its pids stay unknown"
                );
            }

            for (const [pid, count] of parseOpenFileCounts(result.stdout)) {
                counts.set(pid, count);
            }
        } catch (err) {
            log.warn({ err, pids: batch.length }, "lsof batch could not be spawned; its pids stay unknown");
        }
    }

    return counts;
}

/**
 * The readable name of a process, from its argv: the basename of argv[0].
 *
 * Matches what `ps aux` parsing produced before, so a filter that used to match
 * still matches.
 */
export function processBasename(command: string): string {
    const argv0 = command.trim().split(/\s+/)[0] ?? "";

    if (argv0 === "") {
        return command.trim();
    }

    return argv0.split("/").pop() || argv0;
}
