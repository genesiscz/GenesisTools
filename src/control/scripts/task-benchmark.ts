import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { out } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { ComputerUse } from "../lib/computer-use/session";

export async function benchmarkControlTask(options: { app: string; windowId: number; hostPaced: boolean }) {
    const computer = new ComputerUse();
    const signal = AbortSignal.timeout(options.hostPaced ? 300000 : 120000);
    const input = options.hostPaced ? createInterface({ input: process.stdin }) : undefined;
    const replies = input?.[Symbol.asyncIterator]();
    const runs: Array<{
        round: number;
        mode: string;
        verified: boolean;
        requests: number | null;
        actions: number | null;
        hostDispatches: number;
        elapsedMs: number;
        error?: string;
    }> = [];
    const next = async (step: string) => {
        if (!replies) {
            return;
        }
        out.result({
            next: step,
            command: "next",
            note: "Benchmark host dispatch boundary; not a user approval prompt.",
        });
        const reply = await new Promise<IteratorResult<string>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Host dispatch deadline expired")), 60000);
            replies
                .next()
                .then(resolve, reject)
                .finally(() => clearTimeout(timer));
        });
        assert.equal(reply.done, false, "Host input closed");
        assert.equal(reply.value, "next", "Send exactly next for the printed operation");
    };
    const exact = { identifier: "line-numbers", value: "1" };
    try {
        for (let round = 0; round < (options.hostPaced ? 1 : 4); round++) {
            for (const mode of round % 2 ? ["compound", "stepwise"] : ["stepwise", "compound"]) {
                const state = await computer.get_app_state({
                    app: options.app,
                    window_id: options.windowId,
                    image: false,
                    signal,
                });
                const toggle = state.elements.filter((row) => row.identifier === "line-numbers");
                assert.equal(toggle.length, 1, "Fixture toggle must be unique");
                if (String(toggle[0].value) === "1") {
                    const reset = await computer.click({
                        app: options.app,
                        element_ref: toggle[0].ref,
                        prepare: true,
                        signal,
                    });
                    assert.equal(reset.ok, true, "Fixture reset failed");
                }
                const initial = await computer.verify_state({
                    app: options.app,
                    expect: "Line numbers disabled",
                    exact: { ...exact, value: "0" },
                    signal,
                });
                assert.equal(initial.status, "verified", "Each measured arm must start disabled");
                const clock = new Stopwatch();
                let hostDispatches = 0;
                let requests: number | null = 0;
                let actions: number | null = 0;
                const boundary = async (name: string) => {
                    await next(`${mode}: computer.${name}`);
                    if (options.hostPaced) {
                        hostDispatches++;
                    }
                };
                try {
                    if (mode === "compound") {
                        await boundary("assist_task");
                        requests = null;
                        actions = null;
                        const result = await computer.assist_task({
                            app: options.app,
                            window_id: options.windowId,
                            goal: "Enable the Show line numbers checkbox.",
                            chooser: "auto",
                            jev: true,
                            provider: "typesafe",
                            exact,
                            max_steps: 2,
                            max_requests: 2,
                            timeout_ms: 10000,
                            signal,
                        });
                        requests = result.metrics.requests;
                        actions = result.metrics.actions;
                        assert.equal(result.status, "verified", result.reason);
                    } else {
                        await boundary("get_app_state");
                        await computer.get_app_state({
                            app: options.app,
                            window_id: options.windowId,
                            image: false,
                            signal,
                        });
                        await boundary("resolve_target");
                        requests = null;
                        const choice = await computer.resolve_target({
                            app: options.app,
                            intent: "Enable the Show line numbers checkbox.",
                            chooser: "jev",
                            provider: "typesafe",
                            signal,
                        });
                        requests = choice.metrics.requests;
                        assert.ok(choice.ref, "Jev abstained; keep the failed arm");
                        await boundary("click");
                        actions++;
                        const result = await computer.click({
                            app: options.app,
                            element_ref: choice.ref,
                            prepare: true,
                            signal,
                        });
                        assert.equal(result.ok, true, result.error);
                        await boundary("verify_state");
                        const verified = await computer.verify_state({
                            app: options.app,
                            expect: "Line numbers enabled",
                            exact,
                            signal,
                        });
                        assert.equal(verified.status, "verified");
                    }
                    runs.push({
                        round,
                        mode,
                        verified: true,
                        requests,
                        actions,
                        hostDispatches,
                        elapsedMs: clock.elapsedMs,
                    });
                    out.result({ taskBenchmarkRun: runs.at(-1) });
                } catch (error) {
                    runs.push({
                        round,
                        mode,
                        verified: false,
                        requests,
                        actions,
                        hostDispatches,
                        elapsedMs: clock.elapsedMs,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    out.result({ taskBenchmarkFailure: runs.at(-1) });
                    return { ok: false, runs, note: "Stopped at first failure; no uncertain input was retried." };
                }
            }
        }
        const summary = ["stepwise", "compound"].map((mode) => {
            const sample = runs.filter((run) => run.mode === mode && (options.hostPaced || run.round > 0));
            const times = sample.map((run) => run.elapsedMs).sort((a, b) => a - b);
            return {
                mode,
                n: sample.length,
                verified: sample.filter((run) => run.verified).length,
                medianMs: times[Math.floor(times.length / 2)],
                minMs: times[0],
                maxMs: times.at(-1),
                hostDispatches: sample.reduce((sum, run) => sum + run.hostDispatches, 0),
                requests: sample.every((run) => run.requests !== null)
                    ? sample.reduce((sum, run) => sum + (run.requests ?? 0), 0)
                    : null,
                actions: sample.every((run) => run.actions !== null)
                    ? sample.reduce((sum, run) => sum + (run.actions ?? 0), 0)
                    : null,
            };
        });
        return {
            ok: true,
            runs,
            summary,
            hostPaced: options.hostPaced,
            note: options.hostPaced
                ? "Actual stdin host dispatches, including orchestration wait in wall time. Same fixture/task and native core. No competing runtime used; one paired observation, not statistical parity."
                : "Interleaved native end-to-end tasks; first pair retained but excluded from summary. No synthetic host latency. This measures local orchestration only, not agent turns or another computer-use runtime.",
        };
    } finally {
        input?.close();
        computer.close_session();
    }
}
