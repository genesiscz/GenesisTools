#!/usr/bin/env bun
/**
 * Baseline for the two Codex control-channel polls.
 *
 * ARM 1 — the daemon control loop, `src/codex/daemon.ts:172`. It calls
 * `readControlRequests(name, afterSeq)` and sleeps 50 ms, for the whole life of
 * the daemon. `readControlRequests` goes through `readRequests`
 * (`src/codex/lib/control-channel.ts:22-29`), which reads and re-parses the
 * entire `.control.jsonl` file every time and only then filters by sequence, so
 * a long-lived session re-parses every control request it has ever received
 * twenty times a second while nothing is happening.
 *
 * This arm is a SHAPE REPLICA: `daemon.ts` is an executable entrypoint that
 * starts a real Codex app-server, so the benchmark drives the same five-line
 * loop itself against the same real `readControlRequests`. The function under
 * test is real; only the `while` around it is local, and the read count is
 * therefore exact rather than inferred.
 *
 * ARM 2 — `waitForControlResponse`, `src/codex/lib/control-channel.ts:58-75`.
 * It calls `existsSync` on the response path and sleeps 20 ms, for up to 30 s.
 * The real function runs here, unmodified.
 *
 * HOW ARM 2 IS COUNTED. Not by the fs counter. `existsSync` is an ESM NAMED
 * import in `control-channel.ts`, so it binds to the function value at import
 * time and patching the `node:fs` module object cannot reach it — measured, and
 * the script prints the fs counter's own verdict as a diagnostic so the zero is
 * visible rather than assumed. The count instead comes from intercepting
 * `Bun.sleep`, which the loop reads off the `Bun` object on every iteration.
 * The loop body is exactly one `existsSync` followed by one `Bun.sleep(20)`, so
 * the sleep count IS the check count.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaselineMetrics, sampleSelf, withFsCounter } from "@app/benchmark/lib";
import { appendControlRequest, readControlRequests, waitForControlResponse } from "@app/codex/lib/control-channel";
import { sessionControlPath } from "@app/codex/lib/paths";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { addCommonOptions, type CommonFlags, runPollBenchmark } from "./harness";

/** The daemon's own cadence, `src/codex/daemon.ts:196`. */
const CONTROL_LOOP_SLEEP_MS = 50;
/** `waitForControlResponse`'s own cadence, `src/codex/lib/control-channel.ts:71`. */
const RESPONSE_POLL_SLEEP_MS = 20;

type AnyFn = (...args: unknown[]) => unknown;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** Count `Bun.sleep(ms)` calls made with exactly `ms` for the duration of `fn`. */
async function withSleepCounter<T>(ms: number, fn: () => Promise<T>): Promise<{ result: T; sleeps: number }> {
    const savedSleep = Bun.sleep;
    const callSleep = savedSleep as unknown as AnyFn;
    let sleeps = 0;

    Bun.sleep = ((...args: unknown[]) => {
        if (args[0] === ms) {
            sleeps += 1;
        }

        return callSleep(...args);
    }) as unknown as typeof Bun.sleep;

    try {
        return { result: await fn(), sleeps };
    } finally {
        Bun.sleep = savedSleep;
    }
}

/** A temp `GENESIS_TOOLS_HOME` with a control file holding `requests` real entries. */
async function createControlFile(requests: number): Promise<{ name: string; controlPath: string; bytes: number }> {
    const home = mkdtempSync(join(tmpdir(), "gt-bench-codex-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    const name = `bench-${Date.now()}`;

    for (let i = 0; i < requests; i++) {
        await appendControlRequest(name, { op: "steer", body: `queued control request ${i}`, force: false });
    }

    const controlPath = sessionControlPath(name);
    return { name, controlPath, bytes: statSync(controlPath).size };
}

async function measure(requests: number, loopMs: number, waitMs: number): Promise<BaselineMetrics> {
    const fixture = await createControlFile(requests);

    // Arm 1: the daemon loop shape, driving the real readControlRequests.
    const lastSeq = requests;
    let reads = 0;
    const loopStartedAt = performance.now();
    const [, loopSample] = await Promise.all([
        (async () => {
            const deadline = Date.now() + loopMs;

            while (Date.now() < deadline) {
                await readControlRequests(fixture.name, lastSeq);
                reads += 1;
                await Bun.sleep(CONTROL_LOOP_SLEEP_MS);
            }
        })(),
        sampleSelf({ windowMs: loopMs, countThreads: false }),
    ]);
    const loopSec = (performance.now() - loopStartedAt) / 1000;

    await delay(50);

    // Arm 2: the real waitForControlResponse against a response that never lands.
    const waitStartedAt = performance.now();
    const [counted, waitSample] = await Promise.all([
        withSleepCounter(RESPONSE_POLL_SLEEP_MS, async () => {
            return withFsCounter(async () => {
                try {
                    await waitForControlResponse(fixture.name, "bench-request-id", waitMs);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);

                    if (!message.includes("Timed out")) {
                        throw err;
                    }
                }

                return null;
            });
        }),
        sampleSelf({ windowMs: waitMs, countThreads: false }),
    ]);
    const waitSec = (performance.now() - waitStartedAt) / 1000;

    out.log.info(
        `fs counter saw ${counted.result.total} node:fs calls inside waitForControlResponse — the named-import blind spot, as expected`
    );

    return {
        controlReads: reads,
        readsPerSec: Number((reads / loopSec).toFixed(2)),
        bytesParsedPerSec: Math.round((reads * fixture.bytes) / loopSec),
        loopCpuPercent: Number(loopSample.cpuPercent.toFixed(2)),
        existsChecks: counted.sleeps,
        existsChecksPerSec: Number((counted.sleeps / waitSec).toFixed(2)),
        waitCpuPercent: Number(waitSample.cpuPercent.toFixed(2)),
    };
}

const program = addCommonOptions(
    new Command()
        .name("codex-control-loop")
        .description("Measure the Codex daemon control loop and waitForControlResponse polls")
        .option("--requests <n>", "How many entries the fixture control file holds", "200")
        .option("--loop-ms <ms>", "How long the control-loop arm runs", "3000")
        .option("--wait-ms <ms>", "Timeout for the waitForControlResponse arm", "2000")
);
await program.parseAsync(process.argv);
const flags = program.opts<CommonFlags & { requests: string; loopMs: string; waitMs: string }>();
const requests = Math.max(1, Number.parseInt(flags.requests, 10) || 200);
const loopMs = Math.max(100, Number.parseInt(flags.loopMs, 10) || 3000);
const waitMs = Math.max(100, Number.parseInt(flags.waitMs, 10) || 2000);

out.log.info(
    `Each run drives the control loop for ${loopMs} ms, then waits ${waitMs} ms for a response that never lands.`
);

await runPollBenchmark({
    stem: "codex-control-loop",
    title: "codex control channel — whole-file re-parse every 50 ms, existsSync every 20 ms",
    setup: `real readControlRequests and waitForControlResponse, ${requests}-entry temp control file, ${loopMs} ms loop, ${waitMs} ms wait`,
    flags,
    measure: () => measure(requests, loopMs, waitMs),
});
