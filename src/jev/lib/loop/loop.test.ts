import { expect, test } from "bun:test";
import type { Observation } from "@app/control/lib/decision/observation";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { createAxSurface } from "./ax";
import { runGoalLoop } from "./run";
import type { GoalSurface } from "./surface";

function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}

const observation: Observation = {
    ok: true,
    app: "Fixture",
    pid: 1,
    snapshot: "tok",
    window: { id: 1, title: "Fixture" },
    scope: "window",
    elements: [
        {
            index: 0,
            depth: 0,
            role: "AXButton",
            AXTitle: "Export",
            AXEnabled: "1",
            visible: true,
            actions: ["AXPress"],
        },
    ],
};

test("AX fixture loop verifies on done", async () => {
    const evaluate: Evaluator = async () =>
        evaluation({
            target: { type: "choice", choice: "abstain", probabilities: { c0: 0.05, abstain: 0.95 } },
            verb: {
                type: "choice",
                choice: "abstain",
                probabilities: { press: 0.05, set: 0, scroll: 0, abstain: 0.95 },
            },
            done: { type: "boolean", probability: 0.96 },
            blocked: { type: "boolean", probability: 0.01 },
            wait: { type: "boolean", probability: 0.01 },
            risk: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0 } },
        });
    const surface = createAxSurface({
        observe: async () => observation,
        act: async () => ({ ok: true }),
    });
    const result = await runGoalLoop({ goal: "Export finished", surface, evaluate });
    expect(result.status).toBe("verified");
});

test("browser fixture clicks a snapshot uid once", async () => {
    const clicks: string[] = [];
    const surface: GoalSurface = {
        kind: "browser",
        see: async () => ({
            id: "nav-1",
            label: "example",
            candidates: [{ id: "1_2", label: "Export", element: -1, action: "click" }],
        }),
        act: async (_snapshot, candidate) => {
            clicks.push(candidate.id);
            return { ok: true };
        },
    };
    const result = await runGoalLoop({
        goal: "click export",
        surface,
        evaluate: async () => evaluation({}),
        maxSteps: 1,
    });
    expect(clicks).toEqual(["1_2"]);
    expect(result.steps).toBe(1);
});

test("high risk without --yes stops", async () => {
    const evaluate: Evaluator = async () =>
        evaluation({
            target: { type: "choice", choice: "c0", probabilities: { c0: 0.9, abstain: 0.1 } },
            verb: { type: "choice", choice: "press", probabilities: { press: 0.9, set: 0, scroll: 0, abstain: 0.1 } },
            done: { type: "boolean", probability: 0.1 },
            blocked: { type: "boolean", probability: 0.01 },
            wait: { type: "boolean", probability: 0.01 },
            risk: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } },
        });
    const surface = createAxSurface({
        observe: async () => observation,
        act: async () => ({ ok: true }),
    });
    const result = await runGoalLoop({ goal: "Delete", surface, evaluate });
    expect(result.status).toBe("stopped");
    expect(result.reason).toBe("high_risk");
});
