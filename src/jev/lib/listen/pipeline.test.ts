import { expect, test } from "bun:test";
import type { Observation } from "@app/control/lib/decision/observation";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { SafeJSON } from "@genesiscz/utils/json";
import type { PrefetchPayload } from "../prefetch";
import { parsePageList } from "./chrome";
import { axView, createListenPipeline, type ListenSurface } from "./pipeline";
import { listenCandidates } from "./verbs";

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

function observationWith(snapshot: string, title = "Export"): Observation {
    return {
        ok: true,
        app: "Fixture",
        pid: 1,
        snapshot,
        window: { id: 1, title: "Fixture" },
        scope: "window",
        elements: [
            {
                index: 0,
                depth: 0,
                role: "AXButton",
                AXTitle: title,
                AXEnabled: "1",
                visible: true,
                actions: ["AXPress"],
            },
        ],
    };
}

const observation = observationWith("tok-1");

function distribution(choice: string, mass = 0.92) {
    const keys = ["c0", "back", "next_tab", "prev_tab", "close_tab", "reload", "abstain"];
    const rest = (1 - mass) / (keys.length - 1);
    return Object.fromEntries(keys.map((key) => [key, key === choice ? mass : rest]));
}

function chooser(choice: string, extra: Partial<Record<"terminal" | "correction", number>> = {}): Evaluator {
    return async () =>
        evaluation({
            verb: { type: "choice", choice, probabilities: distribution(choice) },
            terminal: { type: "boolean", probability: extra.terminal ?? 0.95 },
            correction: { type: "boolean", probability: extra.correction ?? 0.01 },
        });
}

const winner = chooser("c0");

function surfaceWith(options: {
    see?: () => Promise<Observation>;
    onAct?: (payload: PrefetchPayload) => void;
}): ListenSurface {
    const see = options.see ?? (async () => observation);
    return {
        see: async () => axView(await see()),
        act: async (payload) => {
            options.onAct?.(payload);
            return { ok: true };
        },
    };
}

const final = (text: string, startedAtMs = 1): LiveTranscriptEvent => ({
    kind: "final",
    text,
    isFinal: true,
    startedAtMs,
});
const partial = (text: string, startedAtMs = 1): LiveTranscriptEvent => ({
    kind: "partial",
    text,
    isFinal: false,
    startedAtMs,
});

test("auto surface prefixes observed ids", () => {
    expect(listenCandidates(observation, "ax").some((item) => item.id === "ax:c0")).toBe(true);
});

test("partial below the gate does not act", async () => {
    const acts: PrefetchPayload[] = [];
    const evaluate: Evaluator = async () =>
        evaluation({
            verb: { type: "choice", choice: "c0", probabilities: distribution("c0", 0.51) },
            terminal: { type: "boolean", probability: 0.2 },
            correction: { type: "boolean", probability: 0.01 },
        });
    const pipeline = createListenPipeline({
        evaluate,
        surface: surfaceWith({ onAct: (payload) => acts.push(payload) }),
    });
    const decision = await pipeline.decide(partial("ex"));
    expect(decision.status).toBe("abstain");
    expect(acts).toEqual([]);
});

test("final above the gate acts once after a readback see whose token differs but whose evidence is equal", async () => {
    const acts: PrefetchPayload[] = [];
    let sees = 0;
    const pipeline = createListenPipeline({
        evaluate: winner,
        surface: surfaceWith({
            see: async () => {
                sees++;
                return observationWith(`tok-${sees}`);
            },
            onAct: (payload) => acts.push(payload),
        }),
    });
    const decision = await pipeline.decide(final("click export"));
    expect(decision.status).toBe("act");
    expect(decision.reason).toBe("dispatched");
    expect(acts).toEqual([{ element: 0, action: "press", uid: "c0" }]);
    expect(sees).toBe(3);
    expect(decision.readback).toEqual({ changed: 0, sample: [] });
});

test("the post-act readback reports the evidence rows the act changed", async () => {
    let sees = 0;
    const pipeline = createListenPipeline({
        evaluate: winner,
        surface: surfaceWith({
            see: async () => {
                sees++;
                return sees >= 3 ? observationWith("tok-3", "Exported") : observation;
            },
        }),
    });
    const decision = await pipeline.decide(final("click export"));
    expect(decision.status).toBe("act");
    expect(decision.readback?.changed).toBe(1);
    expect(decision.readback?.sample[0]).toContain("Exported");
});

test("changed evidence between the choice and the act holds instead of acting (negative control)", async () => {
    const acts: PrefetchPayload[] = [];
    let sees = 0;
    const pipeline = createListenPipeline({
        evaluate: winner,
        surface: surfaceWith({
            see: async () => {
                sees++;
                return sees === 1 ? observation : observationWith("tok-2", "Cancel");
            },
            onAct: (payload) => acts.push(payload),
        }),
    });
    const decision = await pipeline.decide(final("click export"));
    expect(decision.status).toBe("hold");
    expect(decision.reason).toBe("stale_snapshot");
    expect(acts).toEqual([]);
});

test("dry-run never calls act", async () => {
    let called = false;
    const pipeline = createListenPipeline({
        evaluate: winner,
        dryRun: true,
        surface: surfaceWith({ onAct: () => (called = true) }),
    });
    const decision = await pipeline.decide(final("click export"));
    expect(decision.status).toBe("would");
    expect(decision.reason).toBe("dry_run");
    expect(called).toBe(false);
});

test("chrome verb back reaches act with a chrome payload", async () => {
    const acts: PrefetchPayload[] = [];
    const pipeline = createListenPipeline({
        evaluate: chooser("back"),
        surface: surfaceWith({ onAct: (payload) => acts.push(payload) }),
    });
    const decision = await pipeline.decide(final("go back"));
    expect(decision.status).toBe("act");
    expect(acts).toEqual([{ element: -1, action: "chrome", uid: "back", chrome: "back" }]);
});

test("dispatch-ahead: a prefetch built on the partial lets the final act without a second see", async () => {
    let sees = 0;
    const acts: PrefetchPayload[] = [];
    const pipeline = createListenPipeline({
        evaluate: chooser("c0", { terminal: 0.3 }),
        dispatchAhead: true,
        now: () => 1000,
        surface: surfaceWith({
            see: async () => {
                sees++;
                return observation;
            },
            onAct: (payload) => acts.push(payload),
        }),
    });
    const held = await pipeline.decide(partial("click exp"));
    expect(held.status).toBe("would");
    expect(sees).toBe(1);
    const acted = await pipeline.decide(final("click export"));
    expect(acted.status).toBe("act");
    expect(acted.reason).toBe("prefetch_hit");
    // One see for the partial, none before the act (that is the point of dispatch-ahead), one
    // post-act readback see.
    expect(sees).toBe(2);
    expect(acts).toHaveLength(1);
    expect(acted.readback).toEqual({ changed: 0, sample: [] });
});

test("correction drops the intent and does not dispatch", async () => {
    let acts = 0;
    const pipeline = createListenPipeline({
        evaluate: async (call) => {
            const state = SafeJSON.stringify(call.input);
            if (state.includes("scratch that")) {
                return evaluation({
                    verb: { type: "choice", choice: "c0", probabilities: distribution("c0") },
                    terminal: { type: "boolean", probability: 0.95 },
                    correction: { type: "boolean", probability: 0.96 },
                });
            }

            return winner({ input: call.input, signal: call.signal });
        },
        surface: surfaceWith({ onAct: () => acts++ }),
    });
    await pipeline.decide(final("click export"));
    expect(acts).toBe(1);
    const retracted = await pipeline.decide(final("no scratch that", 2));
    expect(retracted.status).toBe("abstain");
    expect(retracted.reason).toBe("correction");
    expect(acts).toBe(1);
});

test("stop phrases end the intent without a Jev call", async () => {
    let evaluations = 0;
    const pipeline = createListenPipeline({
        evaluate: async (call) => {
            evaluations++;
            return winner({ input: call.input, signal: call.signal });
        },
        surface: surfaceWith({}),
    });
    const decision = await pipeline.decide(final("never mind"));
    expect(decision.status).toBe("stop");
    expect(evaluations).toBe(0);
});

test("wake mode contains: nothing routes before the phrase; the remainder routes after it", async () => {
    const acts: PrefetchPayload[] = [];
    let evaluations = 0;
    const pipeline = createListenPipeline({
        evaluate: async (call) => {
            evaluations++;
            return winner({ input: call.input, signal: call.signal });
        },
        wake: { mode: "contains", phrases: ["hey jev"] },
        surface: surfaceWith({ onAct: (payload) => acts.push(payload) }),
    });
    const ignored = await pipeline.decide(final("click export"));
    expect(ignored.status).toBe("abstain");
    expect(ignored.reason).toBe("not_woken");
    expect(evaluations).toBe(0);
    const woken = await pipeline.decide(final("hey jev click export", 2));
    expect(woken.status).toBe("act");
    expect(woken.command).toBe("click export");
    expect(acts).toHaveLength(1);
    expect(pipeline.isArmed()).toBe(false);
});

test("wake mode jev: destructive commands hold until confirmed", async () => {
    let acts = 0;
    const evaluate: Evaluator = async (call) => {
        const state = SafeJSON.stringify(call.input);
        if (state.includes('"woke"')) {
            return evaluation({
                woke: { type: "boolean", probability: 0.95 },
                remainder: {
                    type: "choice",
                    choice: "after-wake",
                    probabilities: { "after-wake": 0.9, whole: 0.05, none: 0.05 },
                },
                destructive: { type: "boolean", probability: 0.9 },
                complete: { type: "boolean", probability: 0.9 },
            });
        }

        return winner({ input: call.input, signal: call.signal });
    };
    const blocked = createListenPipeline({
        evaluate,
        wake: { mode: "jev", phrases: ["hey jev"] },
        surface: surfaceWith({ onAct: () => acts++ }),
    });
    const held = await blocked.decide(final("hey jev send it"));
    expect(held.status).toBe("hold");
    expect(held.reason).toBe("destructive_needs_confirm");
    expect(acts).toBe(0);

    const confirmed = createListenPipeline({
        evaluate,
        wake: { mode: "jev", phrases: ["hey jev"], confirmDestructive: true },
        surface: surfaceWith({ onAct: () => acts++ }),
    });
    const acted = await confirmed.decide(final("hey jev send it"));
    expect(acted.status).toBe("act");
    expect(acts).toBe(1);
});

test("parsePageList reads the chrome-devtools-mcp list_pages format", () => {
    const pages = parsePageList(
        [
            "## Pages",
            "1: Example Domain (https://example.com/) [selected]",
            "2: Draft: refactor (col-1): sagas (https://gitlab.example/merge_requests/7404/diffs?commit_id=abc)",
            "5: https://github.example/org/",
            "54: Jev fixture page (http://127.0.0.1:3990/)",
            "noise",
        ].join("\n")
    );
    expect(pages).toHaveLength(4);
    expect(pages[0]).toMatchObject({ index: 1, title: "Example Domain", url: "https://example.com/", selected: true });
    expect(pages[1]).toMatchObject({
        index: 2,
        url: "https://gitlab.example/merge_requests/7404/diffs?commit_id=abc",
        selected: false,
    });
    expect(pages[2]).toMatchObject({ index: 5, title: "", url: "https://github.example/org/" });
    expect(pages[3]).toMatchObject({ index: 54, title: "Jev fixture page", url: "http://127.0.0.1:3990/" });
});
