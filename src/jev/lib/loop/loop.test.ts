import { expect, test } from "bun:test";
import type { Observation } from "@app/control/lib/decision/observation";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { createAutoSurface } from "./auto";
import { createAxSurface } from "./ax";
import { prefixCandidateId } from "./prefix";
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

function browserFixture(clicks: string[]): GoalSurface {
    return {
        kind: "browser",
        see: async () => ({
            id: "nav-1",
            label: "example",
            candidates: [
                { id: "1_1", label: "Home", element: -1, action: "click", role: "link" },
                { id: "1_2", label: "Export", element: -1, action: "click", role: "button" },
            ],
        }),
        act: async (_snapshot, candidate) => {
            clicks.push(candidate.id);
            return { ok: true };
        },
    };
}

/** Builds a full distribution over the request's target criteria: admittedChoice rejects partial ones. */
function choose(target: string): Evaluator {
    return async (call) => {
        const input = call.input as { questions?: { target?: { criteria?: Record<string, unknown> } } };
        const keys = Object.keys(input.questions?.target?.criteria ?? { [target]: 1, abstain: 1 });
        const rest = 0.05 / Math.max(1, keys.length - 1);
        const probabilities = Object.fromEntries(keys.map((key) => [key, key === target ? 0.95 : rest]));
        return evaluation({
            target: { type: "choice", choice: target, probabilities },
            verb: {
                type: "choice",
                choice: "press",
                probabilities: { press: 0.95, set: 0.02, scroll: 0.01, abstain: 0.02 },
            },
            done: { type: "boolean", probability: 0.05 },
            blocked: { type: "boolean", probability: 0.02 },
            wait: { type: "boolean", probability: 0.03 },
            risk: { type: "score", score: 0 },
        });
    };
}

test("browser fixture clicks the uid Jev chose, never the first row blind", async () => {
    const clicks: string[] = [];
    const result = await runGoalLoop({
        goal: "click export",
        surface: browserFixture(clicks),
        evaluate: choose("1_2"),
        maxSteps: 1,
    });
    expect(clicks).toEqual(["1_2"]);
    expect(result.steps).toBe(1);
    expect(result.trace[0]).toMatchObject({ status: "act", target: "1_2", dispatched: true, candidates: 2 });
});

test("browser fixture without a Jev decision does not click anything (negative control)", async () => {
    const clicks: string[] = [];
    const result = await runGoalLoop({
        goal: "click export",
        surface: browserFixture(clicks),
        evaluate: async () => evaluation({}),
        maxSteps: 1,
    });
    expect(clicks).toEqual([]);
    expect(result.status).toBe("stopped");
    expect(result.steps).toBe(0);
});

test("auto surface lets Jev choose a cdp row and routes the act to the browser", async () => {
    const clicks: string[] = [];
    const auto = createAutoSurface({
        ax: createAxSurface({ observe: async () => observation, act: async () => ({ ok: true }) }),
        browser: browserFixture(clicks),
    });
    const result = await runGoalLoop({
        goal: "click export on the page",
        surface: auto,
        evaluate: choose("cdp:1_2"),
        maxSteps: 1,
    });
    expect(clicks).toEqual(["1_2"]);
    expect(result.trace[0]?.target).toBe("cdp:1_2");
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

test("auto surface prefixes ax and cdp ids", async () => {
    const auto = createAutoSurface({
        ax: createAxSurface({
            observe: async () => observation,
            act: async () => ({ ok: true }),
        }),
        browser: {
            kind: "browser",
            see: async () => ({
                id: "nav-1",
                label: "page",
                candidates: [{ id: "1_2", label: "Export", element: -1, action: "click" }],
            }),
            act: async () => ({ ok: true }),
        },
    });
    const snapshot = await auto.see();
    expect(snapshot.candidates.map((item) => item.id)).toEqual(["ax:c0", "cdp:1_2"]);
    expect(prefixCandidateId("cdp", "1_2")).toBe("cdp:1_2");
});

test("browser act rejects a model-supplied CSS selector", async () => {
    const { createBrowserSurface } = await import("./browser");
    const surface = createBrowserSurface({ port: 9 });
    const result = await surface.act(
        { id: "nav", label: "x", candidates: [{ id: "div.export", label: "x", element: -1, action: "click" }] },
        { id: "div.export", label: "x", element: -1, action: "click" }
    );
    expect(result.ok).toBe(false);
    // A selector-shaped id maps to no browser verb and never reaches an MCP call.
    expect(result.error).toMatch(/uid|verb|snapshot/i);
});
