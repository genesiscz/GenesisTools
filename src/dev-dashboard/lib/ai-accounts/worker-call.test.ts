import { describe, expect, test } from "bun:test";
import { callWorker, WorkerCallTimeoutError } from "@app/dev-dashboard/lib/ai-accounts/worker-call";
import type {
    BlockFixtureInput,
    BlockFixtureOutput,
} from "@app/dev-dashboard/lib/ai-accounts/worker-call.block-fixture";

const FIXTURE = new URL("./worker-call.block-fixture.ts", import.meta.url);

const BLOCK_MS = 300;
const TIMER_MS = 50;

function blockThisThread(ms: number): void {
    const started = Date.now();

    while (Date.now() - started < ms) {
        // Same busy loop as the fixture, deliberately on the caller's thread.
    }
}

function timerThatRecords(order: string[], ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(() => {
            order.push("timer");
            resolve();
        }, ms);
    });
}

/**
 * The 30-day spend query held the request thread for tens of seconds, so
 * `/api/ai/daemon` waited behind it and `/api/ai/usage/series` came back 502
 * `upstream-timeout` (sweep 2026-09-04, defect 3). These tests assert the
 * property that fixes it: slow work runs somewhere the event loop is not.
 */
describe("callWorker", () => {
    test("a blocking job does not stop the caller's timers", async () => {
        const order: string[] = [];
        const timer = timerThatRecords(order, TIMER_MS);
        const call = callWorker<BlockFixtureInput, BlockFixtureOutput>(
            FIXTURE,
            { blockMs: BLOCK_MS },
            { timeoutMs: 10_000, label: "fixture" }
        ).then((out) => {
            order.push("worker");
            return out;
        });

        const [, result] = await Promise.all([timer, call]);

        expect(order).toEqual(["timer", "worker"]);
        expect(result.blockedMs).toBeGreaterThanOrEqual(BLOCK_MS);
    });

    test("negative control: the same job on this thread starves the same timer", async () => {
        const order: string[] = [];
        const timer = timerThatRecords(order, TIMER_MS);

        blockThisThread(BLOCK_MS);
        order.push("inline");
        await timer;

        expect(order).toEqual(["inline", "timer"]);
    });

    test("a job that overruns rejects with a named error rather than hanging", async () => {
        const call = callWorker<BlockFixtureInput, BlockFixtureOutput>(
            FIXTURE,
            { blockMs: 5_000 },
            { timeoutMs: 60, label: "fixture" }
        );

        expect(call).rejects.toThrow(WorkerCallTimeoutError);
    });

    test("the timeout message names the work and the budget", () => {
        expect(new WorkerCallTimeoutError("transcript spend scan", 60_000).message).toBe(
            "transcript spend scan did not finish within 60s"
        );
    });
});
