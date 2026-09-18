import { expect, test } from "bun:test";
import type { Observation } from "@app/control/lib/decision/observation";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { createListenPipeline } from "./pipeline";

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
    snapshot: "tok-1",
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

function distribution(choice: string, mass = 0.92) {
    const keys = ["c0", "back", "next_tab", "prev_tab", "close_tab", "reload", "abstain"];
    const rest = (1 - mass) / (keys.length - 1);
    return Object.fromEntries(keys.map((key) => [key, key === choice ? mass : rest]));
}

const winner: Evaluator = async () =>
    evaluation({
        verb: { type: "choice", choice: "c0", probabilities: distribution("c0") },
        terminal: { type: "boolean", probability: 0.95 },
    });

test("partial below the gate does not act", async () => {
    const acts: string[] = [];
    const evaluate: Evaluator = async () =>
        evaluation({
            verb: { type: "choice", choice: "c0", probabilities: distribution("c0", 0.51) },
            terminal: { type: "boolean", probability: 0.2 },
        });
    const pipeline = createListenPipeline({
        evaluate,
        dryRun: false,
        surface: {
            see: async () => observation,
            act: async () => {
                acts.push("act");
                return { ok: true };
            },
        },
    });
    const event: LiveTranscriptEvent = { kind: "partial", text: "ex", isFinal: false, startedAtMs: 1 };
    const decision = await pipeline.decide(event);
    expect(decision.status).toBe("abstain");
    expect(acts).toEqual([]);
});

test("final above the gate on a fresh token acts once", async () => {
    const acts: string[] = [];
    const pipeline = createListenPipeline({
        evaluate: winner,
        surface: {
            see: async () => observation,
            act: async () => {
                acts.push("act");
                return { ok: true };
            },
        },
    });
    const decision = await pipeline.decide({
        kind: "final",
        text: "click export",
        isFinal: true,
        startedAtMs: 1,
    });
    expect(decision.status).toBe("act");
    expect(acts).toEqual(["act"]);
});

test("dry-run never calls act", async () => {
    let called = false;
    const pipeline = createListenPipeline({
        evaluate: winner,
        dryRun: true,
        surface: {
            see: async () => observation,
            act: async () => {
                called = true;
                return { ok: true };
            },
        },
    });
    const decision = await pipeline.decide({
        kind: "final",
        text: "click export",
        isFinal: true,
        startedAtMs: 1,
    });
    expect(decision.status).toBe("would");
    expect(called).toBe(false);
});

test("chrome verb back is choosable", async () => {
    const evaluate: Evaluator = async () =>
        evaluation({
            verb: { type: "choice", choice: "back", probabilities: distribution("back") },
            terminal: { type: "boolean", probability: 0.96 },
        });
    const pipeline = createListenPipeline({
        evaluate,
        dryRun: true,
        surface: {
            see: async () => observation,
            act: async () => ({ ok: true }),
        },
    });
    const decision = await pipeline.decide({
        kind: "final",
        text: "go back",
        isFinal: true,
        startedAtMs: 1,
    });
    expect(decision.choice).toBe("back");
    expect(decision.status).toBe("would");
});

test("prefetch hit dispatches without a second see", async () => {
    let sees = 0;
    const pipeline = createListenPipeline({
        evaluate: winner,
        dispatchAhead: true,
        surface: {
            see: async () => {
                sees += 1;
                return observation;
            },
            act: async () => ({ ok: true }),
        },
    });
    await pipeline.decide({ kind: "final", text: "click export", isFinal: true, startedAtMs: 1 });
    expect(sees).toBe(1);
    const hit = await pipeline.dispatchIfPrefetched("c0");
    expect(hit?.reason).toBe("prefetch_hit");
    expect(sees).toBe(1);
});
