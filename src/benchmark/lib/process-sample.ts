import { logger } from "@genesiscz/utils/logger";
import { parseProcRssBytes, parseProcStatCpuMs, parseProcThreads } from "@genesiscz/utils/process/linux-proc";
import { readProcessUsages } from "@genesiscz/utils/process/processes";
import { parseCpuTime } from "@genesiscz/utils/process/ps";

const { log } = logger.scoped("benchmark-sample");

/**
 * CPU and memory consumed by one process over a measured window.
 *
 * This is a DELTA measurement, which is the only honest way to read idle burn:
 * `ps %cpu` on macOS is a decayed average over the process's whole life, so a
 * daemon that spun for an hour yesterday and is quiet now still reads high.
 * Two `cputime` snapshots a known interval apart cannot be gamed that way.
 *
 * Not to be confused with `ProcessSample` in `src/chrome-devtools/lib/platform.ts`,
 * which is a single snapshot (lifetime-average CPU, CPU time as a string) used to
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

export { parseCpuTime, parseProcRssBytes, parseProcStatCpuMs, parseProcThreads };

function snapshot(pid: number): Promise<RawSnapshot | null> {
    return Promise.resolve(readProcessUsages([pid]).get(pid) ?? null);
}

/**
 * Thread count for one pid, from the process layer; zero when unavailable.
 */
export async function countThreads(pid: number): Promise<number> {
    return readProcessUsages([pid]).get(pid)?.threads ?? 0;
}

function unsupportedSample(pid: number, windowMs: number): ProcessSample {
    return { pid, windowMs, cpuTimeMs: 0, cpuPercent: 0, rssBytes: 0, threads: 0, alive: false };
}

/**
 * Measure one process over a window by taking two CPU-time snapshots.
 *
 * The process layer chooses the platform reader. If either sample is unavailable,
 * the result reports `alive: false` rather than inventing a CPU delta.
 *
 * ```ts
 * const sample = await sampleProcess(daemonPid, { windowMs: 30_000 });
 * // sample.cpuPercent === 1.9 means the daemon burns 1.9% of one core while idle.
 * ```
 */
export async function sampleProcess(pid: number, opts: { windowMs: number }): Promise<ProcessSample> {
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
 * Pass `countThreads: false` to skip the layer's thread count in a hot loop,
 * which reports `threads: 0`.
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
