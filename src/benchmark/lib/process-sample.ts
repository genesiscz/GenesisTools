import { readFileSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("benchmark-sample");

/**
 * Linux reports per-process CPU time in clock ticks. USER_HZ is 100 on every
 * mainstream build, and there is no cheap userspace way to read the real value,
 * so the Linux path assumes it. A wrong assumption here scales cpuTimeMs by a
 * constant factor, which a baseline diff (same host, same kernel) cancels out.
 */
const LINUX_USER_HZ = 100;

/**
 * CPU and memory consumed by one process over a measured window.
 *
 * This is a DELTA measurement, which is the only honest way to read idle burn:
 * `ps %cpu` on macOS is a decayed average over the process's whole life, so a
 * daemon that spun for an hour yesterday and is quiet now still reads high.
 * Two `cputime` snapshots a known interval apart cannot be gamed that way.
 *
 * Not to be confused with `ProcessSample` in `src/chrome-devtools/lib/platform.ts`,
 * which is a single `ps` snapshot (decayed `%cpu`, `cputime` as a string) used to
 * describe a browser process, not to measure it.
 */
export interface ProcessSample {
    pid: number;
    /** The window actually measured, which under load can exceed the requested one. */
    windowMs: number;
    /** Delta of (user + system) CPU time across the window. */
    cpuTimeMs: number;
    /** cpuTimeMs / windowMs * 100. One fully busy core is 100, two cores is 200. */
    cpuPercent: number;
    /** Resident set size at the END of the window. */
    rssBytes: number;
    /** Thread count at the END of the window. 0 when the platform cannot report it. */
    threads: number;
    /** False when the pid could not be read at either end of the window. */
    alive: boolean;
}

interface RawSnapshot {
    cpuTimeMs: number;
    rssBytes: number;
    /** null when the platform needs a separate call for the thread count. */
    threads: number | null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Parse a POSIX `ps -o time` cell into milliseconds.
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

/** Parse `Threads:\t7` out of a Linux /proc/<pid>/status body. */
export function parseProcThreads(status: string): number | null {
    const match = status.match(/^Threads:\s+(\d+)$/m);

    if (!match) {
        return null;
    }

    return Number(match[1]);
}

/** Parse `VmRSS:\t  12345 kB` out of a Linux /proc/<pid>/status body, in bytes. */
export function parseProcRssBytes(status: string): number | null {
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);

    if (!match) {
        return null;
    }

    return Number(match[1]) * 1024;
}

/**
 * Parse utime + stime out of a Linux /proc/<pid>/stat line, in milliseconds.
 * The comm field can contain spaces and parentheses, so everything before the
 * LAST `)` is discarded rather than split.
 */
export function parseProcStatCpuMs(stat: string): number | null {
    const close = stat.lastIndexOf(")");

    if (close < 0) {
        return null;
    }

    // After the comm field, index 0 is `state` (stat field 3), so stat field N
    // sits at index N - 3: utime is 14 and stime is 15.
    const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);

    if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
        return null;
    }

    return ((utime + stime) / LINUX_USER_HZ) * 1000;
}

async function runPs(args: string[]): Promise<string | null> {
    const proc = Bun.spawn(["ps", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        log.debug({ args, exitCode: proc.exitCode, stderr: stderr.trim() }, "ps returned non-zero");
        return null;
    }

    return stdout;
}

async function psSnapshot(pid: number): Promise<RawSnapshot | null> {
    const stdout = await runPs(["-o", "time=,rss=", "-p", String(pid)]);

    if (stdout === null) {
        return null;
    }

    const line = stdout.trim().split("\n")[0] ?? "";
    const fields = line.trim().split(/\s+/);
    const cpuTimeMs = parseCpuTime(fields[0] ?? "");
    const rssKb = Number(fields[1]);

    if (cpuTimeMs === null || !Number.isFinite(rssKb)) {
        log.debug({ pid, line }, "could not parse the ps snapshot line");
        return null;
    }

    return { cpuTimeMs, rssBytes: rssKb * 1024, threads: null };
}

function procSnapshot(pid: number): RawSnapshot | null {
    try {
        const cpuTimeMs = parseProcStatCpuMs(readFileSync(`/proc/${pid}/stat`, "utf8"));
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const rssBytes = parseProcRssBytes(status);
        const threads = parseProcThreads(status);

        if (cpuTimeMs === null || rssBytes === null) {
            log.debug({ pid }, "could not parse /proc for the snapshot");
            return null;
        }

        return { cpuTimeMs, rssBytes, threads };
    } catch (err) {
        log.debug({ err, pid }, "reading /proc for the snapshot failed");
        return null;
    }
}

function snapshot(pid: number): Promise<RawSnapshot | null> {
    if (process.platform === "linux") {
        return Promise.resolve(procSnapshot(pid));
    }

    return psSnapshot(pid);
}

/**
 * Thread count for one pid. On macOS this costs an extra `ps -M` spawn, so it
 * runs once per sample (after the window closes), never per snapshot. On Linux
 * the snapshot already carries it and this is never reached.
 */
export async function countThreads(pid: number): Promise<number> {
    if (process.platform === "linux") {
        return procSnapshot(pid)?.threads ?? 0;
    }

    const stdout = await runPs(["-M", "-p", String(pid)]);

    if (stdout === null) {
        return 0;
    }

    const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0);
    return Math.max(0, lines.length - 1);
}

function unsupportedSample(pid: number, windowMs: number): ProcessSample {
    return { pid, windowMs, cpuTimeMs: 0, cpuPercent: 0, rssBytes: 0, threads: 0, alive: false };
}

/**
 * Measure one process over a window by taking two CPU-time snapshots.
 *
 * Costs two `ps` spawns on macOS plus one `ps -M` for the thread count, and
 * zero spawns on Linux (it reads /proc). Windows is not supported: the sample
 * comes back with `alive: false` and a logged warning, because a wrong number
 * is worse than an obvious absence.
 *
 * ```ts
 * const sample = await sampleProcess(daemonPid, { windowMs: 30_000 });
 * // sample.cpuPercent === 1.9 means the daemon burns 1.9% of one core while idle.
 * ```
 */
export async function sampleProcess(pid: number, opts: { windowMs: number }): Promise<ProcessSample> {
    if (process.platform === "win32") {
        log.warn({ pid }, "sampleProcess is not implemented on Windows; reporting the sample as not alive");
        return unsupportedSample(pid, opts.windowMs);
    }

    const startedAt = performance.now();
    const first = await snapshot(pid);
    await delay(opts.windowMs);
    const second = await snapshot(pid);
    const windowMs = Math.round(performance.now() - startedAt);

    if (first === null || second === null) {
        log.debug({ pid, windowMs }, "the pid could not be read at one end of the window");
        return unsupportedSample(pid, windowMs);
    }

    const cpuTimeMs = Math.max(0, second.cpuTimeMs - first.cpuTimeMs);
    const threads = second.threads ?? (await countThreads(pid));

    return {
        pid,
        windowMs,
        cpuTimeMs,
        cpuPercent: windowMs > 0 ? (cpuTimeMs / windowMs) * 100 : 0,
        rssBytes: second.rssBytes,
        threads,
        alive: true,
    };
}

/**
 * Measure THIS process over a window.
 *
 * `process.cpuUsage()` is exact and costs nothing, so prefer this over
 * `sampleProcess(process.pid, …)` whenever the code under test runs in-process.
 * The thread count still costs one `ps -M` spawn on macOS; pass
 * `countThreads: false` to skip it in a hot loop, which reports `threads: 0`.
 */
export async function sampleSelf(opts: { windowMs: number; countThreads?: boolean }): Promise<ProcessSample> {
    const startedAt = performance.now();
    const cpuBefore = process.cpuUsage();
    await delay(opts.windowMs);
    const cpu = process.cpuUsage(cpuBefore);
    const windowMs = Math.round(performance.now() - startedAt);
    const cpuTimeMs = (cpu.user + cpu.system) / 1000;
    const wantThreads = opts.countThreads ?? true;

    return {
        pid: process.pid,
        windowMs,
        cpuTimeMs,
        cpuPercent: windowMs > 0 ? (cpuTimeMs / windowMs) * 100 : 0,
        rssBytes: process.memoryUsage().rss,
        threads: wantThreads ? await countThreads(process.pid) : 0,
        alive: true,
    };
}
