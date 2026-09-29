import { expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { settingsWindowObservation } from "./__fixtures__/settings-window";
import { candidatesFor, type Observation, observedEvidence } from "./observation";
import { observeFanout } from "./observe";
import { regionsCoveredByElements, textsMatch } from "./visual-merge";

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

test("fan-out request contains the five question ids and no separate verb", async () => {
    let questionIds: string[] = [];
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        questionIds = Object.keys(request.questions);
        return evaluation(answers());
    };
    const result = await observeFanout({ observation, goal: "Export the document", evaluate });
    expect(questionIds.sort()).toEqual(["blocked", "done", "risk", "target", "wait"]);
    expect(result.status).toBe("act");
    expect(result.target?.element).toBe(0);
    expect(result.verb).toBe("press");
});

/**
 * Before: a verb answered on its own had its own admission gate, so an admitted target with a split
 * verb distribution abstained, and "scroll" was offered with nothing scrollable to act on.
 */
test("an admitted target acts with its own action whatever the model says about verbs", async () => {
    const evaluate: Evaluator = async () =>
        evaluation(
            answers({
                verb: {
                    type: "choice",
                    choice: "scroll",
                    probabilities: { press: 0.4, set: 0.1, scroll: 0.45, abstain: 0.05 },
                },
            })
        );
    const result = await observeFanout({ observation, goal: "Export the document", evaluate });
    expect(result.status).toBe("act");
    expect(result.verb).toBe("press");
});

test("a caller's candidate keeps its own action as the verb", async () => {
    const evaluate: Evaluator = async () =>
        evaluation(answers({ target: { type: "choice", choice: "q1", probabilities: { q1: 0.95, abstain: 0.05 } } }));
    const result = await observeFanout({
        observation,
        goal: "Type the order number",
        evaluate,
        candidates: [{ id: "q1", element: -1, action: "set", label: "Order number", role: "textbox", ancestors: [] }],
    });
    expect(result.status).toBe("act");
    expect(result.verb).toBe("set");
});

/**
 * Before: set rows were merged in by id, and both candidatesFor lists number from c0, so a set row
 * reached the model only when its index exceeded the press count. When one did, assist dispatched
 * it with no value to type.
 */
test("the default candidates are press rows only, because a fan-out has no value to type", async () => {
    let offered: string[] = [];
    const fields: Observation = {
        ...observation,
        elements: [
            observation.elements[0],
            ...[1, 2].map((index) => ({
                index,
                depth: 0,
                role: "AXTextField",
                AXTitle: `Field ${index}`,
                AXEnabled: "1",
                visible: true,
                valueSettable: true,
                actions: [],
            })),
        ],
    };
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        const target = request.questions.target;
        offered = target?.type === "choice" ? Object.keys(target.criteria) : [];
        return evaluation(
            answers({ target: { type: "choice", choice: "c0", probabilities: { c0: 0.95, abstain: 0.05 } } })
        );
    };
    await observeFanout({ observation: fields, goal: "Export the document", evaluate });
    expect(candidatesFor({ observation: fields, action: "set" })).toHaveLength(2);
    expect(offered.sort()).toEqual(["abstain", "c0"]);
});

test("labels already tried on this screen reach the state and the target instructions", async () => {
    const requests: ReturnType<typeof evaluationSchema.parse>[] = [];
    const evaluate: Evaluator = async (call) => {
        requests.push(evaluationSchema.parse(call.input));
        return evaluation(answers());
    };
    await observeFanout({ observation, goal: "Export the document", evaluate });
    await observeFanout({ observation, goal: "Export the document", evaluate, triedHere: ["Cancel"] });
    const [plain, tried] = requests;
    const instructionsOf = (request: (typeof requests)[number]) => {
        const target = request.questions.target;
        return target?.type === "choice" ? target.instructions : "";
    };
    expect(plain.state).not.toHaveProperty("already_tried_on_this_screen");
    expect(instructionsOf(plain)).not.toContain("already_tried_on_this_screen");
    expect(tried.state).toMatchObject({ already_tried_on_this_screen: ["Cancel"] });
    expect(instructionsOf(tried)).toContain("already_tried_on_this_screen");
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

test("recovery question appears only after a refusal", async () => {
    let without: string[] = [];
    let withRefusal: string[] = [];
    const evaluate: Evaluator = async (call) => {
        const ids = Object.keys(evaluationSchema.parse(call.input).questions);
        if (without.length === 0) {
            without = ids;
        } else {
            withRefusal = ids;
        }
        return evaluation(answers());
    };
    await observeFanout({ observation, goal: "Export the document", evaluate });
    await observeFanout({
        observation,
        goal: "Export the document",
        evaluate,
        lastRefusal: "stale_observation",
        remedies: [{ id: "dismiss-sheet", description: "Dismiss the blocking sheet" }],
    });
    expect(without.sort()).toEqual(["blocked", "done", "risk", "target", "wait"]);
    expect(withRefusal).toContain("recovery");
    expect(withRefusal).toContain("rebind");
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

test("observed evidence carries the document URL of a web area and nothing else gains one", () => {
    const browser: Observation = {
        ...observation,
        elements: [
            {
                index: 0,
                depth: 0,
                role: "AXWebArea",
                AXURL: "https://example.test/orders",
                visible: true,
                actions: [],
            },
            ...observation.elements.map((row) => ({ ...row, index: row.index + 1, depth: 1 })),
        ],
    };
    const evidence = observedEvidence(browser);
    expect(evidence[0]).toMatchObject({ role: "AXWebArea", url: "https://example.test/orders" });
    expect(evidence[1]).not.toHaveProperty("url");

    const navigated = observedEvidence({
        ...browser,
        elements: [{ ...browser.elements[0], AXURL: "https://example.test/invoices" }, ...browser.elements.slice(1)],
    });
    expect(navigated).not.toEqual(evidence);
});

/**
 * t7 — a menu button is "pressed" by showing its menu, and a menu item by picking it. Neither
 * exposes AXPress, and an AXPress-only filter made Flow's whole overflow menu invisible to the
 * chooser: `assist` abstained with no_certain_act after paying for the request. Measured on
 * design.yugen.Flow 2026-09-21.
 */
test("a press candidate carries the AX action its row actually exposes", () => {
    const rows: Observation["elements"] = [
        { index: 0, depth: 0, role: "AXWindow", actions: ["AXRaise"], x: 0, y: 0, width: 400, height: 300 },
        {
            index: 1,
            depth: 1,
            role: "AXMenuButton",
            AXDescription: "menu.dots.vertical.custom",
            actions: ["AXCancel", "AXShowMenu"],
            x: 10,
            y: 10,
            width: 32,
            height: 32,
        },
        {
            index: 2,
            depth: 1,
            role: "AXMenuItem",
            AXTitle: "Settings",
            actions: ["AXCancel", "AXPick", "AXPress"],
            x: 10,
            y: 50,
            width: 196,
            height: 24,
        },
        {
            index: 3,
            depth: 1,
            role: "AXButton",
            AXTitle: "Start",
            actions: ["AXPress"],
            x: 10,
            y: 90,
            width: 60,
            height: 24,
        },
    ];
    const candidates = candidatesFor({ observation: { ...observation, elements: rows }, action: "press" });
    const byRole = new Map(candidates.map((candidate) => [candidate.role, candidate]));

    // The menu button is now choosable, and says AXShowMenu is how to press it.
    expect(byRole.get("AXMenuButton")?.axAction).toBe("AXShowMenu");

    // A row that exposes AXPress keeps AXPress, so nothing carries an override it does not need.
    expect(byRole.get("AXMenuItem")?.axAction).toBeUndefined();
    expect(byRole.get("AXButton")?.axAction).toBeUndefined();
});

/** The other half: a row exposing none of the three press actions is still not a candidate. */
test("a row with no pressable action is still refused", () => {
    const rows: Observation["elements"] = [
        { index: 0, depth: 0, role: "AXWindow", actions: ["AXRaise"], x: 0, y: 0, width: 400, height: 300 },
        {
            index: 1,
            depth: 1,
            role: "AXStaticText",
            AXValue: "05:00",
            actions: ["AXCancel"],
            x: 10,
            y: 10,
            width: 60,
            height: 20,
        },
    ];
    const candidates = candidatesFor({ observation: { ...observation, elements: rows }, action: "press" });

    expect(candidates.filter((candidate) => candidate.role === "AXStaticText")).toHaveLength(0);
});

/**
 * Golden size, ported from typesafe-computer-use `test_request_size.py`: a prompt that silently
 * grows costs money on every step, and nothing else notices. Measured 2026-09-28 on this fixture:
 * 9,672 bytes while the state repeated every candidate, 7,347 bytes without that copy. Raise the
 * ceiling only with a measured reason written here.
 */
test("the fan-out request for a settings window stays under its measured size", async () => {
    const REQUEST_BYTES_CEILING = 7600;
    let bytes = 0;
    let state: Record<string, unknown> = {};
    const evaluate: Evaluator = async (call) => {
        const request = evaluationSchema.parse(call.input);
        bytes = Buffer.byteLength(SafeJSON.stringify(call.input, { strict: true }));
        state = request.state as Record<string, unknown>;
        return evaluation(answers());
    };
    await observeFanout({ observation: settingsWindowObservation(), goal: "Turn on line numbers", evaluate });
    expect(state).not.toHaveProperty("candidates");
    expect(bytes).toBeGreaterThan(5000);
    expect(bytes).toBeLessThanOrEqual(REQUEST_BYTES_CEILING);
});

function toolbar(): Observation {
    return {
        ...observation,
        elements: [
            { index: 0, depth: 0, role: "AXWindow", x: 0, y: 0, width: 600, height: 400, actions: ["AXRaise"] },
            {
                index: 1,
                depth: 1,
                role: "AXButton",
                AXTitle: "Back",
                x: 10,
                y: 10,
                width: 40,
                height: 24,
                actions: ["AXPress"],
            },
            {
                index: 2,
                depth: 1,
                role: "AXButton",
                AXTitle: "Save document",
                x: 60,
                y: 10,
                width: 120,
                height: 24,
                actions: ["AXPress"],
            },
            { index: 3, depth: 1, role: "AXStaticText", AXValue: "Draft", x: 200, y: 10, width: 60, height: 24 },
        ],
    };
}

test("an OCR region is covered by the AX control that shows the same text, or by the control its glyph sits on", () => {
    const covered = regionsCoveredByElements({
        observation: toolbar(),
        regions: [
            { id: "r1", text: "Save", screen: { x: 70, y: 12, width: 40, height: 18 } },
            { id: "r2", text: "←", screen: { x: 22, y: 14, width: 12, height: 14 } },
            { id: "r3", text: "Draft", screen: { x: 205, y: 12, width: 40, height: 18 } },
            { id: "r4", text: "Save", screen: { x: 400, y: 300, width: 40, height: 18 } },
            { id: "r5", text: "Export", screen: { x: 70, y: 12, width: 40, height: 18 } },
        ],
    });
    expect(covered.get("r1")).toEqual({ element: 2, reason: "overlap" });
    expect(covered.get("r2")).toEqual({ element: 1, reason: "icon" });
    // Static text is not actionable, a far-away "Save" is not the button, and other text is not its label.
    expect(covered.has("r3")).toBe(false);
    expect(covered.has("r4")).toBe(false);
    expect(covered.has("r5")).toBe(false);
});

test("labels match by containment or by at least half of the shorter label's words", () => {
    expect(textsMatch("Save", "Save document")).toBe(true);
    expect(textsMatch("Show line numbers", "Show numbers")).toBe(true);
    expect(textsMatch("Cancel", "Save document")).toBe(false);
    expect(textsMatch("—", "Save")).toBe(false);
});

test("a row ax-tool found blank on screen is neither a candidate nor evidence; an unmarked row stays", () => {
    const hidden: Observation = {
        ...toolbar(),
        elements: toolbar().elements.map((row) => (row.index === 2 ? { ...row, drawn: false } : row)),
    };
    const pressable = candidatesFor({ observation: hidden, action: "press" }).map((candidate) => candidate.element);
    expect(pressable).toContain(1);
    expect(pressable).not.toContain(2);
    expect(observedEvidence(hidden).some((row) => row.id === "e2")).toBe(false);
    expect(observedEvidence(toolbar()).some((row) => row.id === "e2")).toBe(true);
});

test("a concrete act admitted more confidently than done is taken before the loop may stop", async () => {
    const evaluate: Evaluator = async () =>
        evaluation(
            answers({
                target: { type: "choice", choice: "c0", probabilities: { c0: 0.97, c1: 0.02, abstain: 0.01 } },
                done: { type: "boolean", probability: 0.85 },
                blocked: { type: "boolean", probability: 0.01 },
            })
        );
    const result = await observeFanout({ observation, goal: "Turn it on and save", evaluate });
    expect(result.status).toBe("act");
    expect(result.target?.element).toBe(0);
});

test("a reversible act passes a lower gate, and the same split on a risky act abstains (negative control)", async () => {
    const split =
        (risk: number): Evaluator =>
        async () =>
            evaluation(
                answers({
                    target: { type: "choice", choice: "c0", probabilities: { c0: 0.77, c1: 0.14, abstain: 0.09 } },
                    risk: { type: "score", score: risk, probabilities: { "0": 1, "1": 0, "2": 0 } },
                })
            );
    const reversible = await observeFanout({ observation, goal: "Accept the terms", evaluate: split(0.1) });
    expect(reversible.status).toBe("act");

    const risky = await observeFanout({ observation, goal: "Send the order", evaluate: split(1.2), allowYes: true });
    expect(risky.status).toBe("abstained");
});
