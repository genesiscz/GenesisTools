import type { ControlDriver } from "@app/control/lib/decision/native";
import type { Observation } from "@app/control/lib/decision/observation";
import { observeFanout } from "@app/control/lib/decision/observe";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { encodeWatchState, type WatchOcrBlock } from "./state";

export interface WatchResult {
    status: "verified" | "stopped" | "cancelled";
    reason: string;
    ticks: number;
    observes: number;
    lastState?: ReturnType<typeof encodeWatchState>;
    lastRefusal?: string;
    hz: number;
}

export async function runWatch(options: {
    goal: string;
    driver: ControlDriver;
    evaluate: Evaluator;
    hz: number;
    maxSeconds: number;
    maxRequests: number;
    ocr?: WatchOcrBlock[];
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
    let previous: Observation | undefined;
    let lastState: ReturnType<typeof encodeWatchState> | undefined;
    let lastRefusal: string | undefined;
    while ((options.now ?? Date.now)() < deadline) {
        options.signal?.throwIfAborted();
        const observation = await options.driver.observe({ signal: options.signal });
        observes += 1;
        ticks += 1;
        lastState = encodeWatchState(observation, previous, options.ocr);
        previous = observation;
        if (requests >= options.maxRequests) {
            return {
                status: "stopped",
                reason: "request_budget",
                ticks,
                observes,
                lastState,
                lastRefusal,
                hz: options.hz,
            };
        }

        const fanout = await observeFanout({
            observation,
            goal: options.goal,
            evaluate: options.evaluate,
            signal: options.signal,
            lastRefusal,
            stateExtras: lastState,
        });
        requests += 1;
        if (fanout.status === "verified") {
            return {
                status: "verified",
                reason: fanout.reason,
                ticks,
                observes,
                lastState,
                lastRefusal,
                hz: options.hz,
            };
        }

        if (fanout.status === "blocked" || fanout.status === "escalate") {
            lastRefusal = fanout.reason;
            return {
                status: "stopped",
                reason: fanout.reason,
                ticks,
                observes,
                lastState,
                lastRefusal,
                hz: options.hz,
            };
        }

        const remaining = deadline - (options.now ?? Date.now)();
        await sleep(Math.max(0, Math.min(interval, remaining)));
    }
    return { status: "stopped", reason: "time_budget", ticks, observes, lastState, lastRefusal, hz: options.hz };
}
