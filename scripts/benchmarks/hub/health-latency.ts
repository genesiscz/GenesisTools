import { loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { askHubServer, type HubServerProbe } from "@app/hub/server/client";
import { out } from "@genesiscz/utils/logger";

interface Observation {
    state: HubServerProbe["state"];
    ms: number;
    load1: number;
}

/** Percentiles describe completed replies. Keep timeouts and missing listeners in the same report. */
export function healthDistribution(observations: Observation[]) {
    const sorted = observations
        .filter((row) => row.state === "answers")
        .map((row) => row.ms)
        .sort((a, b) => a - b);
    const quantile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
    return {
        attempts: observations.length,
        answers: sorted.length,
        busy: observations.filter((row) => row.state === "busy").length,
        absent: observations.filter((row) => row.state === "absent").length,
        p50Ms: quantile(0.5),
        p95Ms: quantile(0.95),
        p99Ms: quantile(0.99),
        maxMs: sorted.at(-1) ?? null,
    };
}

// Run once in each observed load condition. Never starts a server or manufactures machine load.
if (import.meta.main) {
    const condition = process.argv[2];
    if (condition !== "normal" && condition !== "loaded") {
        throw new Error("Pass normal or loaded to label the observed workload");
    }

    const observations: Observation[] = [];
    const timeoutMs = 10_000;
    for (let index = 0; index < 100; index++) {
        if (index > 0) {
            await delay(1000);
        }

        const load1 = loadavg()[0];
        const started = performance.now();
        const probe = await askHubServer("health", { timeoutMs });
        observations.push({ state: probe.state, ms: performance.now() - started, load1 });
    }

    out.result({ condition, timeoutMs, ...healthDistribution(observations), observations });
}
