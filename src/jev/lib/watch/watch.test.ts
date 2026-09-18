import { expect, test } from "bun:test";
import type { ControlDriver } from "@app/control/lib/decision/native";
import type { Observation } from "@app/control/lib/decision/observation";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { runWatch } from "./loop";

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
            AXTitle: "Send",
            AXEnabled: "1",
            visible: true,
            actions: ["AXPress"],
        },
    ],
};

test("watch stops verified when done becomes true", async () => {
    let step = 0;
    const evaluate: Evaluator = async () => {
        step += 1;
        return evaluation({
            target: { type: "choice", choice: "abstain", probabilities: { c0: 0.1, abstain: 0.9 } },
            verb: { type: "choice", choice: "abstain", probabilities: { press: 0.1, set: 0, scroll: 0, abstain: 0.9 } },
            done: { type: "boolean", probability: step >= 3 ? 0.95 : 0.1 },
            blocked: { type: "boolean", probability: 0.01 },
            wait: { type: "boolean", probability: 0.01 },
            risk: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0 } },
        });
    };
    const driver: ControlDriver = {
        observe: async () => observation,
        act: async () => ({ ok: true }),
    };
    let now = 0;
    const result = await runWatch({
        goal: "the send button is enabled",
        driver,
        evaluate,
        hz: 4,
        maxSeconds: 15,
        maxRequests: 8,
        now: () => now,
        sleep: async () => {
            now += 250;
        },
    });
    expect(result.status).toBe("verified");
    expect(result.observes).toBe(3);
});

test("rejects hz outside 1-10", async () => {
    const driver: ControlDriver = {
        observe: async () => observation,
        act: async () => ({ ok: true }),
    };
    await expect(
        runWatch({
            goal: "x",
            driver,
            evaluate: async () => evaluation({}),
            hz: 11,
            maxSeconds: 1,
            maxRequests: 1,
        })
    ).rejects.toThrow(/--hz/);
});
