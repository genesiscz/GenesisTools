import { runWatch } from "../../watch/loop";
import type { FixtureScript } from "../fixture-evaluator";
import { createFixtureWatchDriver, FIXTURE_SURFACE_NOTE } from "../fixtures";
import { type Chapter, createEventLog, mismatch } from "./context";

const GOAL = "The export finished";
const HZ = 4;
const MAX_SECONDS = 5;
const MAX_REQUESTS = 4;

/** Same state-driven script as the loop chapter: the second observation is what verifies. */
export const WATCH_SCRIPT: FixtureScript = {
    choice: [
        [/^target$/, /^abstain$/],
        [/^verb$/, /^abstain$/],
    ],
    boolean: [
        [/^done$/, (state: string) => (state.includes("Export Done") ? 0.96 : 0.05)],
        [/^blocked$/, 0.02],
        [/^wait$/, 0.02],
    ],
    score: [[/^risk$/, 0]],
};

/** A watch that never acts: it re-observes on a clock until the fan-out reports the goal is true. */
export const watchChapter: Chapter = async (context) => {
    const log = createEventLog(context.now);
    const { driver, observes } = createFixtureWatchDriver();
    log.add("surface", `${FIXTURE_SURFACE_NOTE}; ${HZ} Hz, ${MAX_REQUESTS} request budget`);
    const result = await runWatch({
        goal: GOAL,
        driver,
        evaluate: context.evaluator(WATCH_SCRIPT),
        hz: HZ,
        maxSeconds: MAX_SECONDS,
        maxRequests: MAX_REQUESTS,
        signal: context.signal,
        now: context.now,
        sleep: async () => undefined,
    });
    log.add(`watch:${result.status}`, `${result.reason} after ${result.ticks} ticks, ${observes()} observations`);
    const readback = result.status === "verified" && result.ticks >= 2;
    log.add("readback", `status ${result.status} ticks ${result.ticks}`);
    return {
        readback,
        reason: readback
            ? "watch_verified_on_the_changed_state"
            : mismatch("verified after at least 2 ticks", `${result.status}:${result.reason} ticks=${result.ticks}`),
        events: log.events(),
        result: { ...result, seeCalls: observes(), surface: FIXTURE_SURFACE_NOTE },
    };
};
