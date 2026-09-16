#!/usr/bin/env bun
/**
 * Baseline for `startWakefulInterval` — `src/utils/wakeful.ts:101`.
 *
 * `wakefulSleep` never sleeps for the whole interval. It wakes every
 * `WAKEFUL_TICK_MS` (2 s) so a kqueue timer dropped across a macOS sleep
 * self-heals, which means a daemon asking for one wakeup a minute gets thirty.
 * Nine daemons use it. The tick is deliberate, so this baseline is here to size
 * the cost rather than to condemn it: it says how many timer wakeups and how
 * much CPU one idle interval actually costs.
 *
 * WHAT IS REAL HERE. The real `startWakefulInterval`, with a tick callback that
 * does nothing, for a measured window.
 *
 * HOW THE WAKEUPS ARE COUNTED. Not by wrapping `setTimeout`. `wakefulSleep`
 * waits with `Bun.sleep(tickMs)` unless `unref` is set, and `Bun.sleep` never
 * reaches `globalThis.setTimeout`. Passing `unref: true` to move it onto
 * `setTimeout` would measure a different branch than the daemons run, so the
 * script intercepts `Bun.sleep` instead — read off the `Bun` object on every
 * iteration, so the count comes from the function under test. Nothing else in
 * the measured window calls `Bun.sleep`: the script's own waits and
 * `sampleSelf`'s window both use `setTimeout`.
 */
import { type BaselineMetrics, sampleSelf } from "@app/benchmark/lib";
import { out } from "@genesiscz/utils/logger";
import { startWakefulInterval, WAKEFUL_TICK_MS } from "@genesiscz/utils/wakeful";
import { Command } from "commander";
import { addCommonOptions, type CommonFlags, runPollBenchmark } from "./harness";

type AnyFn = (...args: unknown[]) => unknown;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function measure(intervalMs: number, windowMs: number): Promise<BaselineMetrics> {
    const savedSleep = Bun.sleep;
    const callSleep = savedSleep as unknown as AnyFn;
    let wakeups = 0;
    let ticks = 0;

    Bun.sleep = ((...args: unknown[]) => {
        wakeups += 1;
        return callSleep(...args);
    }) as unknown as typeof Bun.sleep;

    const startedAt = performance.now();
    const interval = startWakefulInterval(intervalMs, () => {
        ticks += 1;
    });

    try {
        const sample = await sampleSelf({ windowMs, countThreads: false });
        const elapsedMs = performance.now() - startedAt;
        const observedWakeups = wakeups;
        const observedTicks = ticks;

        return {
            wakeups: observedWakeups,
            wakeupsPerMinute: Number(((observedWakeups / elapsedMs) * 60_000).toFixed(2)),
            wakeupsPerInterval: Number(((observedWakeups / elapsedMs) * intervalMs).toFixed(2)),
            tickInvocations: observedTicks,
            cpuPercent: Number(sample.cpuPercent.toFixed(2)),
        };
    } finally {
        Bun.sleep = savedSleep;
        interval.stop();
        // `stop()` only flips a flag; the in-flight wakefulSleep runs to its next
        // tick boundary before it reads it, and a non-unref Bun.sleep holds the
        // process open until then.
        await delay(WAKEFUL_TICK_MS + 200);
    }
}

const program = addCommonOptions(
    new Command()
        .name("wakeful-wakeups")
        .description("Measure how many timer wakeups one idle startWakefulInterval costs")
        .option("--interval-ms <ms>", "The interval the caller asks for", "10000")
        .option("--window-ms <ms>", "How long the measured window runs", "6000")
);
await program.parseAsync(process.argv);
const flags = program.opts<CommonFlags & { intervalMs: string; windowMs: string }>();
const intervalMs = Math.max(1_000, Number.parseInt(flags.intervalMs, 10) || 10_000);
const windowMs = Math.max(1_000, Number.parseInt(flags.windowMs, 10) || 6_000);

out.log.info(
    `Interval ${intervalMs} ms, tick ${WAKEFUL_TICK_MS} ms, measured over ${windowMs} ms with a no-op callback.`
);

await runPollBenchmark({
    stem: "wakeful-wakeups",
    title: `startWakefulInterval — ${WAKEFUL_TICK_MS} ms tick under a ${intervalMs} ms interval`,
    setup: `real startWakefulInterval, no-op tick, ${windowMs} ms window, Bun.sleep intercepted`,
    flags,
    measure: () => measure(intervalMs, windowMs),
});
