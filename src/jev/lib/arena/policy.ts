import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { z } from "zod";
import { evaluateRequest } from "../service";
import { ARENA_ACTIONS, type ArenaDecision, type ArenaObservation } from "./types";

export const arenaObservationSchema = z
    .object({
        elapsed: z.number().min(0).max(61),
        health: z.number().int().min(0).max(3),
        sugar: z.number().int().min(0).max(20),
        threat: z.enum(["none", "nearby", "imminent"]),
        threatSide: z.enum(["left", "right", "behind", "ahead"]),
        foodSide: z.enum(["left", "right", "ahead"]),
        wall: z.enum(["clear", "near"]),
        currentAction: z.enum(ARENA_ACTIONS),
        neural: z
            .object({
                leftHz: z.number().finite().nonnegative().max(1000),
                rightHz: z.number().finite().nonnegative().max(1000),
                retreat: z.number().min(0).max(1),
                turn: z.number().min(-1).max(1),
                top: z
                    .array(
                        z.object({
                            id: z.string().max(32),
                            type: z.string().max(100),
                            hz: z.number().finite().min(0).max(1000),
                        })
                    )
                    .max(8),
            })
            .nullable(),
    })
    .strict();

export async function decideArena({
    observation,
    signal,
    provider,
    evaluate = evaluateRequest,
}: {
    observation: unknown;
    signal?: AbortSignal;
    provider?: EvaluationProviderId;
    evaluate?: typeof evaluateRequest;
}): Promise<ArenaDecision> {
    const state: ArenaObservation = arenaObservationSchema.parse(observation);
    const started = Date.now();
    const response = await evaluate({
        input: {
            state: {
                ...state,
                goal: "Collect 12 sugar drops within 60 seconds, keep the fly alive. Escape a swatter warning before it strikes.",
            },
            questions: {
                action: {
                    type: "choice",
                    instructions:
                        "Choose the next arcade fly action. Prefer forage when safe. Imminent swatter threat calls for dash. Neural rates are simulated retreat-circuit outputs; use them as a threat cue, not proof. All geometry is already reduced into categorical observations.",
                    criteria: {
                        forage: "Follow the nearest sugar using the game's steering controller.",
                        left: "Turn left while moving forward.",
                        right: "Turn right while moving forward.",
                        dash: "Burst away from the current swatter target; if no threat, burst forward.",
                        wait: "Stop in place briefly.",
                    },
                },
                threat: { type: "boolean", instructions: "Is there an immediate swatter threat to the fly?" },
                survival: {
                    type: "score",
                    instructions: "Assess the current survival outlook.",
                    criteria: ["critical", "poor", "uncertain", "good", "safe"],
                },
            },
        },
        timeoutMs: 8000,
        provider,
        signal,
    });
    const action = response.answers.action;
    const threat = response.answers.threat;
    const survival = response.answers.survival;
    if (
        action?.type !== "choice" ||
        threat?.type !== "boolean" ||
        survival?.type !== "score" ||
        !ARENA_ACTIONS.includes(action.choice as ArenaDecision["action"])
    ) {
        throw new Error("Jev returned an invalid arena decision.");
    }
    const selectedProbability = action.probabilities?.[action.choice] ?? 0;
    const fallback = selectedProbability < 0.45;
    return {
        action: fallback
            ? state.neural && state.neural.retreat > 0.08
                ? "dash"
                : "forage"
            : (action.choice as ArenaDecision["action"]),
        confidence: selectedProbability,
        threatProbability: threat.probability,
        survivalScore: survival.score,
        probabilities: action.probabilities ?? {},
        fallback,
        latencyMs: Date.now() - started,
        usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
    };
}
