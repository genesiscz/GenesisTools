import { observeFanout } from "@app/control/lib/decision/observe";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { GoalSurface, SurfaceSnapshot } from "./surface";

export interface GoalLoopResult {
    status: "verified" | "stopped";
    reason: string;
    steps: number;
}

export async function runGoalLoop(options: {
    goal: string;
    surface: GoalSurface;
    evaluate: Evaluator;
    maxSteps?: number;
    allowYes?: boolean;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
}): Promise<GoalLoopResult> {
    const maxSteps = options.maxSteps ?? 8;
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    let snapshot: SurfaceSnapshot | undefined;
    for (let step = 0; step < maxSteps; step++) {
        options.signal?.throwIfAborted();
        snapshot = await options.surface.see(options.signal);
        if (!snapshot.observation) {
            if (!snapshot.candidates.length) {
                return { status: "stopped", reason: "no_candidates", steps: step };
            }

            const first = snapshot.candidates[0];
            const acted = await options.surface.act(snapshot, first);
            if (!acted.ok) {
                return { status: "stopped", reason: acted.error ?? "act_failed", steps: step + 1 };
            }

            continue;
        }

        const fanout = await observeFanout({
            observation: snapshot.observation,
            goal: options.goal,
            evaluate: options.evaluate,
            signal: options.signal,
            allowYes: options.allowYes,
        });
        if (fanout.status === "verified") {
            return { status: "verified", reason: fanout.reason, steps: step };
        }

        if (fanout.status === "wait") {
            await sleep(250);
            continue;
        }

        if (fanout.status !== "act" || !fanout.target) {
            return { status: "stopped", reason: fanout.reason, steps: step };
        }

        const candidate = snapshot.candidates.find((item) => item.id === fanout.target?.id);
        if (!candidate) {
            return { status: "stopped", reason: "missing_candidate", steps: step };
        }

        const acted = await options.surface.act(snapshot, candidate);
        if (!acted.ok) {
            return { status: "stopped", reason: acted.error ?? "act_failed", steps: step + 1 };
        }
    }
    return { status: "stopped", reason: "step_budget", steps: maxSteps };
}
