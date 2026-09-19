import { candidatesFor } from "@app/control/lib/decision/observation";
import { observeFanout } from "@app/control/lib/decision/observe";
import type { FixtureScript } from "../fixture-evaluator";
import { FIXTURE_SURFACE_NOTE, pendingObservation } from "../fixtures";
import { type Chapter, createEventLog, mismatch } from "./context";

const GOAL = "Start the export";
const EXPECTED_LABEL = "Export";

/** `done` stays low so the fan-out has to choose a target rather than declare the goal reached. */
export const OBSERVE_SCRIPT: FixtureScript = {
    choice: [
        [/^target$/, /Export/],
        [/^verb$/, /^press$/],
    ],
    boolean: [
        [/^done$/, 0.05],
        [/^blocked$/, 0.02],
        [/^wait$/, 0.02],
    ],
    score: [[/^risk$/, 0]],
};

/** One see, one fan-out request, six questions. The real decision layer, not a parsed snapshot. */
export const observeChapter: Chapter = async (context) => {
    const log = createEventLog(context.now);
    const observation = pendingObservation();
    const candidates = candidatesFor({ observation });
    log.add("see", `${FIXTURE_SURFACE_NOTE}; ${candidates.length} press candidates`);
    const fanout = await observeFanout({
        observation,
        goal: GOAL,
        evaluate: context.evaluator(OBSERVE_SCRIPT),
        signal: context.signal,
    });
    log.add(`fanout:${fanout.status}`, `${fanout.verb} → ${fanout.target?.label ?? "none"} (${fanout.reason})`);
    const readback = fanout.status === "act" && fanout.verb === "press" && fanout.target?.label === EXPECTED_LABEL;
    log.add("readback", `target ${fanout.target?.label ?? "none"} vs scripted ${EXPECTED_LABEL}`);
    return {
        readback,
        reason: readback
            ? "fanout_chose_the_scripted_target"
            : mismatch(
                  `act:press:${EXPECTED_LABEL}`,
                  `${fanout.status}:${fanout.verb}:${fanout.target?.label ?? "none"}`
              ),
        events: log.events(),
        result: { goal: GOAL, surface: FIXTURE_SURFACE_NOTE, fanout },
    };
};
