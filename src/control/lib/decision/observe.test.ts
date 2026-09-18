import { expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { Observation } from "./observation";
import { observeFanout } from "./observe";

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
        {
            index: 1,
            depth: 0,
            role: "AXButton",
            AXTitle: "Cancel",
            AXEnabled: "1",
            visible: true,
            actions: ["AXPress"],
        },
    ],
};

function answers(overrides: EvaluationResponse["answers"] = {}) {
    return {
        target: { type: "choice" as const, choice: "c0", probabilities: { c0: 0.9, c1: 0.05, abstain: 0.05 } },
        verb: {
            type: "choice" as const,
            choice: "press",
            probabilities: { press: 0.9, set: 0.02, scroll: 0.02, abstain: 0.06 },
        },
        done: { type: "boolean" as const, probability: 0.1 },
        blocked: { type: "boolean" as const, probability: 0.05 },
        wait: { type: "boolean" as const, probability: 0.05 },
        risk: { type: "score" as const, score: 0, probabilities: { "0": 1, "1": 0, "2": 0 } },
        ...overrides,
    };
}

test("fan-out request contains the six question ids", async () => {
    let questionIds: string[] = [];
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        questionIds = Object.keys(request.questions);
        return evaluation(answers());
    };
    const result = await observeFanout({ observation, goal: "Export the document", evaluate });
    expect(questionIds.sort()).toEqual(["blocked", "done", "risk", "target", "verb", "wait"]);
    expect(result.status).toBe("act");
    expect(result.target?.element).toBe(0);
});

test("done true returns verified without an act target requirement", async () => {
    const evaluate: Evaluator = async () =>
        evaluation(
            answers({ done: { type: "boolean", probability: 0.95 }, blocked: { type: "boolean", probability: 0.01 } })
        );
    const result = await observeFanout({ observation, goal: "Export the document", evaluate });
    expect(result.status).toBe("verified");
});

test("blocked true does not act", async () => {
    const evaluate: Evaluator = async () => evaluation(answers({ blocked: { type: "boolean", probability: 0.95 } }));
    const result = await observeFanout({ observation, goal: "Export the document", evaluate });
    expect(result.status).toBe("blocked");
});

test("high risk without --yes escalates", async () => {
    const evaluate: Evaluator = async () =>
        evaluation(answers({ risk: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } } }));
    const result = await observeFanout({ observation, goal: "Delete the draft", evaluate });
    expect(result.status).toBe("escalate");
});

test("exact readback overrides semantic done", async () => {
    const evaluate: Evaluator = async () => evaluation(answers({ done: { type: "boolean", probability: 0.99 } }));
    const result = await observeFanout({
        observation,
        goal: "Export finished",
        evaluate,
        exact: { identifier: "missing", value: "1" },
    });
    expect(result.status).not.toBe("verified");
});
