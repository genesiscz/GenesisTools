import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("benchmark-loop-stall");

const DEFAULT_TICK_MS = 10;

export interface LoopStallReport {
    /** How long the monitor ran, measured rather than requested. */
    windowMs: number;
    /** How many times the timer fired. */
    ticks: number;
    /** The worst single stall observed. */
    maxStallMs: number;
    /** The 99th percentile stall, which ignores one unlucky tick. */
    p99StallMs: number;
    /** How many ticks were late by MORE than `thresholdMs`. */
    stallsOver: (thresholdMs: number) => number;
}

export interface LoopStallMonitor {
    stop(): LoopStallReport;
}

function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

/**
 * Watch the event loop for stalls while other work runs.
 *
 * A timer set for every `tickMs` should fire `tickMs` after the previous fire.
 * Anything beyond that is time the loop could not reach the callback, which is
 * the definition of a stall: a synchronous block, a `Bun.sleepSync`, a large
 * JSON parse, or a busy-wait. The schedule re-bases on each fire rather than on
 * the start time, so one long stall does not smear across every later tick.
 *
 * The timer is unref'd, so an un-stopped monitor never holds a process open.
 * `stop()` is safe to call more than once and returns the same report.
 *
 * ```ts
 * const monitor = monitorLoopStalls();
 * await handleRequest();
 * const report = monitor.stop();
 * // report.stallsOver(50) === 0 proves nothing blocked the loop for 50ms.
 * ```
 */
export function monitorLoopStalls(opts?: { tickMs?: number }): LoopStallMonitor {
    const tickMs = opts?.tickMs ?? DEFAULT_TICK_MS;
    const startedAt = performance.now();
    const stalls: number[] = [];
    let ticks = 0;
    let lastFire = startedAt;
    let stoppedAt: number | null = null;

    // lint-rules-ignore: stall probe must tick faster than the stalls it measures
    const timer = setInterval(() => {
        const now = performance.now();
        ticks += 1;
        stalls.push(Math.max(0, now - lastFire - tickMs));
        lastFire = now;
    }, tickMs);
    timer.unref();

    return {
        stop(): LoopStallReport {
            if (stoppedAt === null) {
                stoppedAt = performance.now();
                clearInterval(timer);
                log.debug({ ticks, tickMs }, "loop stall monitor stopped");
            }

            const sorted = [...stalls].sort((a, b) => a - b);

            return {
                windowMs: stoppedAt - startedAt,
                ticks,
                maxStallMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
                p99StallMs: percentile(sorted, 0.99),
                stallsOver: (thresholdMs: number) => stalls.filter((stall) => stall > thresholdMs).length,
            };
        },
    };
}
