import type { ControlDriver } from "@app/control/lib/decision/native";
import { observeFanout } from "@app/control/lib/decision/observe";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";

export interface WatchResult {
    status: "verified" | "stopped" | "cancelled";
    reason: string;
    ticks: number;
    observes: number;
}

export async function runWatch(options: {
    goal: string;
    driver: ControlDriver;
    evaluate: Evaluator;
    hz: number;
    maxSeconds: number;
    maxRequests: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}): Promise<WatchResult> {
    if (!Number.isFinite(options.hz) || options.hz < 1 || options.hz > 10) {
        throw new Error("--hz must be an integer from 1 to 10.");
    }

    const interval = 1000 / options.hz;
    const started = (options.now ?? Date.now)();
    const deadline = started + options.maxSeconds * 1000;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    let ticks = 0;
    let observes = 0;
    let requests = 0;
    while ((options.now ?? Date.now)() < deadline) {
        options.signal?.throwIfAborted();
        const observation = await options.driver.observe({ signal: options.signal });
        observes += 1;
        ticks += 1;
        if (requests >= options.maxRequests) {
            return { status: "stopped", reason: "request_budget", ticks, observes };
        }

        const fanout = await observeFanout({
            observation,
            goal: options.goal,
            evaluate: options.evaluate,
            signal: options.signal,
        });
        requests += 1;
        if (fanout.status === "verified") {
            return { status: "verified", reason: fanout.reason, ticks, observes };
        }

        if (fanout.status === "blocked" || fanout.status === "escalate") {
            return { status: "stopped", reason: fanout.reason, ticks, observes };
        }

        const remaining = deadline - (options.now ?? Date.now)();
        await sleep(Math.max(0, Math.min(interval, remaining)));
    }
    return { status: "stopped", reason: "time_budget", ticks, observes };
}
