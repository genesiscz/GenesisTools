import { runGoalLoop } from "../../loop/run";
import type { FixtureScript } from "../fixture-evaluator";
import { createFixtureGoalSurface, FIXTURE_SURFACE_NOTE } from "../fixtures";
import { type Chapter, createEventLog, mismatch } from "./context";

const GOAL = "The export finished";

/**
 * The scripted table is a pure function of the request state, which is how one script drives two
 * different steps: while the fixture window still says "Export pending" the loop must act, and
 * once it says "Export Done" the `done` probability crosses 0.8 and the loop verifies.
 */
export const LOOP_SCRIPT: FixtureScript = {
    choice: [
        [/^target$/, /Export/],
        [/^verb$/, /^press$/],
    ],
    boolean: [
        [/^done$/, (state: string) => (state.includes("Export Done") ? 0.96 : 0.05)],
        [/^blocked$/, 0.02],
        [/^wait$/, 0.02],
    ],
    score: [[/^risk$/, 0]],
};

/** See → decide → act → see again → verify, over an in-memory surface with a real state change. */
export const loopChapter: Chapter = async (context) => {
    const log = createEventLog(context.now);
    const { surface, acted, sees } = createFixtureGoalSurface();
    log.add("surface", FIXTURE_SURFACE_NOTE);
    const result = await runGoalLoop({
        goal: GOAL,
        surface,
        evaluate: context.evaluator(LOOP_SCRIPT),
        maxSteps: 4,
        signal: context.signal,
        sleep: async () => undefined,
    });
    for (const step of result.trace) {
        log.add(`step${step.step}:${step.status}`, `${step.target ?? "none"} dispatched=${step.dispatched === true}`);
    }

    log.add("verified", `${result.status} after ${result.steps} steps, ${sees()} observations`);
    const readback =
        result.status === "verified" &&
        result.trace.length >= 2 &&
        result.trace.some((step) => step.dispatched === true);
    return {
        readback,
        reason: readback
            ? "loop_verified_after_a_dispatched_act"
            : mismatch(
                  "verified with a dispatched step",
                  `${result.status}:${result.reason} steps=${result.trace.length}`
              ),
        events: log.events(),
        result: { ...result, acted, seeCalls: sees(), surface: FIXTURE_SURFACE_NOTE },
    };
};
