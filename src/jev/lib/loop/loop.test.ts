import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation } from "@app/control/lib/decision/observation";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { createAutoSurface } from "./auto";
import { createAxSurface } from "./ax";
import { prefixCandidateId } from "./prefix";
import { MeteredEvaluator, RunFolder, replayRun, type StepRecord } from "./record";
import { callsLine, runGoalLoop, stepTimingLine } from "./run";
import { sameScreen, screenOf } from "./screen";
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

/** An observation with one pressable button per label, so a fixture can press a different one each step. */
function buttons(labels: string[]): Observation {
    return {
        ...observation,
        elements: labels.map((label, index) => ({
            index,
            depth: 0,
            role: "AXButton",
            AXTitle: label,
            AXEnabled: "1",
            visible: true,
            actions: ["AXPress"],
        })),
    };
}

/** Answers every step from a list of target ids; "wait" and "done" script those outcomes instead. */
function script(steps: string[], requests: Array<Record<string, unknown>> = []): Evaluator {
    let step = 0;
    return async (call) => {
        const input = call.input as {
            state: Record<string, unknown>;
            questions: { target?: { criteria?: Record<string, unknown> } };
        };
        requests.push(input.state);
        const choice = steps[Math.min(step, steps.length - 1)];
        step += 1;
        const keys = Object.keys(input.questions.target?.criteria ?? {});
        const target = choice === "wait" || choice === "done" ? "abstain" : choice;
        const rest = 0.05 / Math.max(1, keys.length - 1);
        return evaluation({
            target: {
                type: "choice",
                choice: target,
                probabilities: Object.fromEntries(keys.map((key) => [key, key === target ? 0.95 : rest])),
            },
            done: { type: "boolean", probability: choice === "done" ? 0.95 : 0.02 },
            blocked: { type: "boolean", probability: 0.01 },
            wait: { type: "boolean", probability: choice === "wait" ? 0.95 : 0.02 },
            risk: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0 } },
        });
    };
}

test("acts that change nothing on screen stop the loop as stalled after three", async () => {
    const pressed: string[] = [];
    const still = buttons(["One", "Two", "Three", "Four"]);
    const surface = createAxSurface({
        observe: async () => still,
        act: async (call) => {
            pressed.push(call.candidate.label);
            return { ok: true };
        },
    });
    const result = await runGoalLoop({
        goal: "Open the report",
        surface,
        evaluate: script(["c0", "c1", "c2", "c3"]),
        maxSteps: 8,
    });
    expect(result).toMatchObject({ status: "stopped", reason: "stalled" });
    expect(pressed).toEqual(["One", "Two", "Three"]);
});

test("an act already taken on this screen reaches the model, and a second repeat stops the loop", async () => {
    const pressed: string[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const surface = createAxSurface({
        observe: async () => buttons(["Retry", "Cancel"]),
        act: async (call) => {
            pressed.push(call.candidate.label);
            return { ok: true };
        },
    });
    const result = await runGoalLoop({
        goal: "Reconnect",
        surface,
        evaluate: script(["c0", "c0", "c0"], requests),
        maxSteps: 8,
    });
    expect(result).toMatchObject({ status: "stopped", reason: "repeating" });
    expect(pressed).toEqual(["Retry", "Retry"]);
    expect(requests[0]).not.toHaveProperty("already_tried_on_this_screen");
    expect(requests[1]).toMatchObject({ already_tried_on_this_screen: ["Retry"] });
});

test("waiting on an unchanged screen counts toward neither stop", async () => {
    const surface = createAxSurface({
        observe: async () => buttons(["Load"]),
        act: async () => ({ ok: true }),
    });
    const result = await runGoalLoop({
        goal: "Load the page",
        surface,
        evaluate: script(["c0", "wait", "wait", "wait", "done"]),
        maxSteps: 8,
        sleep: async () => {},
    });
    expect(result).toMatchObject({ status: "verified" });
});

test("a screen that moves after each act is progress, not a stall (negative control)", async () => {
    let count = 0;
    const pressed: string[] = [];
    const surface = createAxSurface({
        observe: async () => buttons([`Next page ${count}`]),
        act: async (call) => {
            pressed.push(call.candidate.label);
            count += 1;
            return { ok: true };
        },
    });
    const result = await runGoalLoop({
        goal: "Read every page",
        surface,
        evaluate: script(["c0"]),
        maxSteps: 5,
    });
    expect(result).toMatchObject({ status: "stopped", reason: "step_budget" });
    expect(pressed).toHaveLength(5);
});

test("one changed line is noise on a long screen and a change on a short one", () => {
    const long = Array.from({ length: 20 }, (_, index) => `AXStaticText|line ${index}|`);
    const clock = { identity: "App Window", lines: [...long, "AXStaticText|12:01|"] };
    expect(sameScreen(clock, { identity: "App Window", lines: [...long, "AXStaticText|12:02|"] })).toBe(true);

    const dialog = { identity: "Dialog", lines: ["AXButton|OK|", "AXStaticText|Saved 1|"] };
    expect(sameScreen(dialog, { identity: "Dialog", lines: ["AXButton|OK|", "AXStaticText|Saved 2|"] })).toBe(false);
    expect(sameScreen(clock, { identity: "Other Window", lines: clock.lines })).toBe(false);
    expect(
        sameScreen(clock, { identity: "App Window", lines: [...long.slice(2), "a", "b", "AXStaticText|12:01|"] })
    ).toBe(false);
});

test("a browser page whose result changes only in text is a new screen, and one clock digit is not", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, role: "link", label: `Item ${index}` }));
    const page = (text: string) =>
        screenOf({
            id: "dom:1",
            label: "Shop",
            candidates: [],
            evidence: { url: "http://127.0.0.1/", title: "Shop", text, nodes },
        });
    const before = page("Your cart. Searching for kettles. Updated 12:01.");
    expect(sameScreen(before, page("Your cart. Found 3 kettles, from 19 EUR. Order summary ready."))).toBe(false);
    expect(sameScreen(before, page("Your cart. Searching for kettles. Updated 12:02."))).toBe(true);
});

test("the meter counts calls, failures and tokens, and hands each step its own calls", async () => {
    let fail = false;
    const metered = new MeteredEvaluator(async () => {
        if (fail) {
            throw new Error("provider down");
        }

        return { ...evaluation({}), usage: { inputTokens: 120, outputTokens: 4, totalTokens: 124 } };
    });
    await metered.evaluate({ input: { state: {}, questions: {} } });
    await metered.evaluate({ input: { state: {}, questions: {} } });
    expect(metered.drain()).toHaveLength(2);
    fail = true;
    await expect(metered.evaluate({ input: { state: {}, questions: {} } })).rejects.toThrow("provider down");
    expect(metered.drain()).toEqual([expect.objectContaining({ error: "provider down" })]);
    expect(metered.meter).toMatchObject({ calls: 3, failures: 1, inputTokens: 240, outputTokens: 8 });
    expect(callsLine(metered.meter)).toContain("jev 3 calls, 1 failed");
    expect(callsLine(metered.meter)).toContain("240 in / 8 out tokens");
});

async function recordedRun(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "jev-runs-"));
    let count = 0;
    const surface = createAxSurface({
        observe: async () => buttons([`Next page ${count}`, "Cancel"]),
        act: async () => {
            count += 1;
            return { ok: true };
        },
    });
    const result = await runGoalLoop({
        goal: "Read two pages",
        surface,
        evaluate: script(["c0", "c0", "done"]),
        maxSteps: 5,
        record: RunFolder.create({ goal: "Read two pages", surface: "ax", root }),
    });
    expect(result.status).toBe("verified");
    expect(result.runDir).toBeDefined();
    expect(stepTimingLine(result.trace[0])).toMatch(/^see \d+ ms · jev \d+ ms \(1 call\) · act \d+ ms$/);
    return result.runDir ?? "";
}

test("a recorded run writes one file per step and a summary, and replays to the same decisions", async () => {
    const dir = await recordedRun();
    expect(readdirSync(dir).sort()).toEqual(["run.json", "step-000.json", "step-001.json", "step-002.json"]);
    const summary = SafeJSON.parse(await Bun.file(join(dir, "run.json")).text(), { strict: true });
    expect(summary).toMatchObject({ goal: "Read two pages", status: "verified", calls: { calls: 3 } });

    const replayed = await replayRun(dir);
    expect(replayed.map((step) => [step.step, step.requestsMatch, step.decisionMatch])).toEqual([
        [0, true, true],
        [1, true, true],
        [2, true, true],
    ]);
});

test("a replay names the step whose saved request or saved decision no longer matches the code", async () => {
    const dir = await recordedRun();
    const file = join(dir, "step-001.json");
    const saved = SafeJSON.parse(await Bun.file(file).text(), { strict: true }) as StepRecord;
    const request = saved.calls[0]?.request as { state: { goal: string } };
    request.state.goal = "a goal the code would never send";
    saved.decision.target = "c1";
    await Bun.write(file, SafeJSON.stringify(saved, null, 2));

    const replayed = await replayRun(dir);
    expect(replayed[0]).toMatchObject({ step: 0, requestsMatch: true, decisionMatch: true });
    expect(replayed[1]).toMatchObject({ step: 1, requestsMatch: false, decisionMatch: false });
});
