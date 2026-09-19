import { describe, expect, test } from "bun:test";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { createListenPipeline, type ListenView } from "./pipeline";
import type { ListenCandidate } from "./verbs";

const final = (text: string): LiveTranscriptEvent => ({ kind: "final", text, isFinal: true, startedAtMs: 1 });

/** Builds a complete distribution from whatever the pipeline actually offered this round. */
function chooser(choice: string): Evaluator {
    return async (call) => {
        const input = call.input as { questions: { verb: { criteria: Record<string, string> } } };
        const probabilities: Record<string, number> = {};
        for (const id of Object.keys(input.questions.verb.criteria)) {
            probabilities[id] = 0;
        }
        probabilities[choice] = 0.99;
        probabilities.abstain = 0.01;
        return {
            answers: {
                verb: { type: "choice", choice, probability: 0.99, probabilities },
                terminal: { type: "boolean", value: true, probability: 0.99 },
                correction: { type: "boolean", value: false, probability: 0.01 },
            },
            providerMetadata: { typesafe: { confidence: { verb: 0.95 } } },
        } as unknown as Awaited<ReturnType<Evaluator>>;
    };
}

function view(candidates: ListenCandidate[], overrides: Partial<ListenView> = {}): ListenView {
    return {
        app: "Brave Browser",
        window: "a page",
        snapshot: `tok-${Math.random()}`,
        candidates,
        rows: candidates.map((item) => ({ id: item.id, role: "row", label: item.label })),
        ...overrides,
    };
}

const row = (over: Partial<ListenCandidate> = {}): ListenCandidate => ({
    id: "c0",
    label: "Odablock 18.7K viewers",
    action: "press",
    element: 4,
    ...over,
});

/** Two views in sequence: the one the choice is made on, then the one the gate re-observes. */
function twoViews(first: ListenView, second: ListenView) {
    const acted: unknown[] = [];
    let call = 0;
    const pipeline = createListenPipeline({
        evaluate: chooser("c0"),
        chromeVerbs: false,
        surface: {
            see: async () => {
                call += 1;
                return call === 1 ? first : second;
            },
            act: async (payload) => {
                acted.push(payload);
                return { ok: true };
            },
        },
    });
    return { pipeline, acted };
}

describe("the freshness gate protects the chosen row, not the whole screen", () => {
    test("AX: unrelated churn does not block, because the row's own identity is unchanged", async () => {
        const chosen = row({ targetKey: "a".repeat(64) });
        const { pipeline, acted } = twoViews(
            view([chosen, row({ id: "c1", label: "3,200 viewers", element: 9, targetKey: "b".repeat(64) })]),
            // The other row's label moved; the chosen row's identity did not.
            view([chosen, row({ id: "c1", label: "3,400 viewers", element: 9, targetKey: "b".repeat(64) })])
        );

        const decision = await pipeline.decide(final("open Odablock"));
        expect(decision.status).toBe("act");
        expect(acted).toHaveLength(1);
    });

    test("AX: the same label on a different element is refused, because the identity changed", async () => {
        const { pipeline, acted } = twoViews(
            view([row({ targetKey: "a".repeat(64) })]),
            view([row({ targetKey: "c".repeat(64) })])
        );

        const decision = await pipeline.decide(final("open Odablock"));
        expect(decision.status).toBe("hold");
        expect(decision.reason).toBe("stale_snapshot");
        expect(acted).toEqual([]);
    });

    test("browser: with no semantic key the label is the identity, and a changed label refuses", async () => {
        const { pipeline, acted } = twoViews(view([row()]), view([row({ label: "Somebody else" })]));

        const decision = await pipeline.decide(final("open Odablock"));
        expect(decision.status).toBe("hold");
        expect(acted).toEqual([]);
    });

    test("either surface: the row vanishing, or the document changing, refuses", async () => {
        const gone = twoViews(view([row()]), view([]));
        expect((await gone.pipeline.decide(final("open Odablock"))).status).toBe("hold");
        expect(gone.acted).toEqual([]);

        const navigated = twoViews(view([row()]), view([row()], { window: "a different page" }));
        expect((await navigated.pipeline.decide(final("open Odablock"))).status).toBe("hold");
        expect(navigated.acted).toEqual([]);
    });
});
