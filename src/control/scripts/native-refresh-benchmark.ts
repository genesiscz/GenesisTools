import assert from "node:assert/strict";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { z } from "zod";
import { NativeControlDriver } from "../lib/decision/native";
import { candidatesFor } from "../lib/decision/observation";
import { ControlSession } from "../lib/decision/session";
import { type AxResult, axCommandLine, ensureBinary } from "../lib/runner";

export async function benchmarkNativeRefresh(options: {
    app: string;
    windowId: number;
    fieldId: string;
    rounds?: number;
}) {
    const rounds = z
        .number()
        .int()
        .min(2)
        .max(30)
        .parse(options.rounds ?? 8);
    const binary = ensureBinary();
    const runs: Array<{ round: number; mode: string; calls: number; nativeCpuMs: number | null; elapsedMs: number }> =
        [];
    for (let round = 0; round < rounds; round++) {
        for (const mode of round % 2 ? ["duplicate-read", "reuse-refresh"] : ["reuse-refresh", "duplicate-read"]) {
            let calls = 0;
            let cpuMs = 0;
            let cpuKnown = true;
            const driver = new NativeControlDriver({
                app: options.app,
                windowId: options.windowId,
                image: false,
                run: async (call) => {
                    calls++;
                    const proc = Bun.spawn(axCommandLine(binary, call.args), {
                        env: env.getProcessEnv(),
                        stdout: "pipe",
                        stderr: "pipe",
                    });
                    const timer = setTimeout(() => proc.kill(), call.timeoutMs ?? 10000);
                    try {
                        const [stdout, stderr, code] = await Promise.all([
                            new Response(proc.stdout).text(),
                            new Response(proc.stderr).text(),
                            proc.exited,
                        ]);
                        assert.equal(code, 0, stderr || stdout);
                        const used = proc.resourceUsage?.()?.cpuTime.total;
                        cpuKnown &&= typeof used === "number" || typeof used === "bigint";
                        if (used !== undefined) {
                            cpuMs += Number(used) / 1000;
                        }
                        const result = SafeJSON.parse(stdout) as AxResult;
                        if (mode === "duplicate-read") {
                            delete result.after;
                        }
                        return result;
                    } finally {
                        clearTimeout(timer);
                    }
                },
            });
            const session = new ControlSession({
                driver,
                evaluate: async () => {
                    throw new Error("Native benchmark never calls AI.");
                },
                limits: { maxActions: 1, maxRequests: 0, timeoutMs: 10000 },
            });
            const watch = new Stopwatch();
            const observation = await session.observe();
            const candidate = candidatesFor({ observation, action: "set" }).find(
                (row) => row.identifier === options.fieldId
            );
            assert.ok(candidate, "Missing fixture field");
            const value = `Benchmark round ${round} arm ${mode === "duplicate-read" ? "A" : "B"}`;
            const result = await session.dispatch({ observation, candidate, value });
            assert.equal(result.result.ok, true);
            assert.equal(result.after?.elements.find((row) => row.AXIdentifier === options.fieldId)?.AXValue, value);
            runs.push({ round, mode, calls, nativeCpuMs: cpuKnown ? cpuMs : null, elapsedMs: watch.elapsedMs });
        }
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summary = ["duplicate-read", "reuse-refresh"].map((mode) => {
        const selected = runs.filter((row) => row.mode === mode && row.round > 0);
        return {
            mode,
            n: selected.length,
            nativeCalls: selected[0]?.calls,
            cpuMedianMs: selected.every((row) => row.nativeCpuMs !== null)
                ? median(selected.map((row) => row.nativeCpuMs!))
                : null,
            elapsedMedianMs: median(selected.map((row) => row.elapsedMs)),
        };
    });
    return {
        summary,
        runs,
        note: "Interleaved fixture runs; first pair discarded. Child CPU includes the signed native launch path, not the target app or cursor overlay.",
    };
}
