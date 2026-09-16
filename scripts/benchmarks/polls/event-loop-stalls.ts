#!/usr/bin/env bun
import { type BaselineMetrics, monitorLoopStalls, withSpawnCounter } from "@app/benchmark/lib";
/**
 * Baseline for the two polls that block the event loop with `Bun.sleepSync`.
 *
 * ARM 1 — `waitFor`, `src/control/commands/verify.ts:45`. It polls an
 * accessibility condition and sleeps between polls with `Bun.sleepSync(interval)`,
 * so the whole timeout is time no other task can run: not a timer, not an HTTP
 * response, not a signal handler. The real exported function runs here with a
 * condition that never holds.
 *
 * ARM 2 — the teammate prompt wait inside `injectLeadAssignment`,
 * `src/claude/lib/teams/launch.ts:205`. Each iteration is a blocking
 * `Bun.spawnSync(tmux capture-pane)` followed by `Bun.sleepSync(250)`. The real
 * exported function runs here against a tmux target that does not exist; the
 * capture fails fast, which is fine, because the blocking sleep is what is being
 * measured. The prompt is empty on purpose, so the function returns as soon as
 * the wait loop ends and never types anything into a pane.
 *
 * Both arms run under `monitorLoopStalls({ tickMs: 10 })`. A 10 ms timer that
 * fires 260 ms late means the loop was unreachable for 250 ms. The monitor's
 * timer cannot fire while the loop is blocked, so each arm yields for one tick
 * afterwards to let the pending fire land and be recorded.
 *
 * `runAx` compiles the native ax-tool on first use if it is stale. That check is
 * warmed once before the measured window, so a 120 s Swift build can never land
 * inside a stall number.
 */
import { injectLeadAssignment } from "@app/claude/lib/teams/launch";
import { waitFor } from "@app/control/commands/verify";
import { runAx } from "@app/control/lib/runner";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { addCommonOptions, type CommonFlags, runPollBenchmark } from "./harness";

/** No app answers to this, so every poll fails and the wait runs its full timeout. */
const MISSING_APP = "GtBenchNoSuchApplication";
/** No tmux server serves this, so every capture-pane fails fast. */
const MISSING_TMUX_TARGET = "gt-bench-no-such-session:0.0";

const MONITOR_TICK_MS = 10;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function measure(
    verifyTimeoutMs: number,
    verifyIntervalMs: number,
    launchWaitMs: number
): Promise<BaselineMetrics> {
    // Arm 1: waitFor, which blocks the loop for its whole timeout.
    const verifyMonitor = monitorLoopStalls({ tickMs: MONITOR_TICK_MS });
    const verifyStartedAt = performance.now();
    const verifyCounted = await withSpawnCounter(async () => {
        return waitFor({
            app: MISSING_APP,
            target: ["--role", "AXButton", "--title", "NoSuchButton"],
            timeout: verifyTimeoutMs,
            interval: verifyIntervalMs,
        });
    });
    const verifyElapsedMs = Math.round(performance.now() - verifyStartedAt);
    await delay(MONITOR_TICK_MS * 3);
    const verifyReport = verifyMonitor.stop();

    if (verifyCounted.result.ok) {
        throw new Error(`waitFor matched an element in ${MISSING_APP}; the never-true condition is not holding`);
    }

    // Arm 2: the teammate prompt wait, spawnSync plus sleepSync per iteration.
    const launchMonitor = monitorLoopStalls({ tickMs: MONITOR_TICK_MS });
    const launchStartedAt = performance.now();
    const launchCounted = await withSpawnCounter(async () => {
        await injectLeadAssignment({ tmuxTarget: MISSING_TMUX_TARGET, prompt: "", waitMs: launchWaitMs });
        return null;
    });
    const launchElapsedMs = Math.round(performance.now() - launchStartedAt);
    await delay(MONITOR_TICK_MS * 3);
    const launchReport = launchMonitor.stop();

    // `verifySpawnCount` is printed but not gated. Within a fixed timeout the number of polls is
    // set by the interval, and the async wait honours it more exactly than `Bun.sleepSync` did:
    // the old loop fitted 4 polls into 1000 ms only because the sync sleep returned late, the new
    // one fits 5 at the documented 200 ms gap. The stall rows are what this benchmark guards.
    out.println(`verify polls (ax-tool spawns) this run: ${verifyCounted.count}`);

    return {
        verifyMaxStallMs: Math.round(verifyReport.maxStallMs),
        verifyP99StallMs: Math.round(verifyReport.p99StallMs),
        verifyStallsOver100Ms: verifyReport.stallsOver(100),
        verifyElapsedMs,
        launchMaxStallMs: Math.round(launchReport.maxStallMs),
        launchP99StallMs: Math.round(launchReport.p99StallMs),
        launchStallsOver100Ms: launchReport.stallsOver(100),
        launchSpawnCount: launchCounted.count,
        launchElapsedMs,
    };
}

const program = addCommonOptions(
    new Command()
        .name("event-loop-stalls")
        .description("Measure the event-loop stalls caused by Bun.sleepSync in waitFor and the teams prompt wait")
        .option("--verify-timeout-ms <ms>", "waitFor timeout", "1000")
        .option("--verify-interval-ms <ms>", "waitFor poll interval, which is also its sleepSync length", "200")
        .option("--launch-wait-ms <ms>", "injectLeadAssignment prompt wait; 4000 is its own default", "4000")
);
await program.parseAsync(process.argv);
const flags = program.opts<CommonFlags & { verifyTimeoutMs: string; verifyIntervalMs: string; launchWaitMs: string }>();
const verifyTimeoutMs = Math.max(100, Number.parseInt(flags.verifyTimeoutMs, 10) || 1000);
const verifyIntervalMs = Math.max(10, Number.parseInt(flags.verifyIntervalMs, 10) || 200);
const launchWaitMs = Math.max(100, Number.parseInt(flags.launchWaitMs, 10) || 4000);

const warm = runAx(["get", "--app", MISSING_APP, "--role", "AXButton"]);
out.log.info(
    `ax-tool warmed outside the measured window (ok=${warm.ok}), so no Swift build lands inside a stall number.`
);

await runPollBenchmark({
    stem: "event-loop-stalls",
    title: "Bun.sleepSync polls — waitFor and the teams prompt wait, measured as event-loop stalls",
    setup: `real waitFor (${verifyTimeoutMs} ms / ${verifyIntervalMs} ms) and real injectLeadAssignment (${launchWaitMs} ms), both against targets that never answer`,
    flags,
    measure: () => measure(verifyTimeoutMs, verifyIntervalMs, launchWaitMs),
});
