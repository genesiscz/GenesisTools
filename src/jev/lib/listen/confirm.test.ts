import { describe, expect, test } from "bun:test";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { createListenPipeline, type ListenView } from "./pipeline";
import type { ListenCandidate } from "./verbs";

const final = (text: string): LiveTranscriptEvent => ({ kind: "final", text, isFinal: true, startedAtMs: 1 });

/** Picks whichever offered row matches `want`, and scores the act at `risk`. */
function chooser(want: (ids: string[]) => string, risk: number): Evaluator {
    return async (call) => {
        const input = call.input as { questions: { verb: { criteria: Record<string, string> } } };
        const ids = Object.keys(input.questions.verb.criteria);
        const choice = want(ids);
        const probabilities: Record<string, number> = {};
        for (const id of ids) {
            probabilities[id] = 0;
        }
        probabilities[choice] = 0.99;
        probabilities.abstain = 0.01;
        return {
            answers: {
                verb: { type: "choice", choice, probability: 0.99, probabilities },
                risk: { type: "score", score: risk },
                terminal: { type: "boolean", value: true, probability: 0.99 },
                correction: { type: "boolean", value: false, probability: 0.01 },
            },
            providerMetadata: { typesafe: { confidence: { verb: 0.95 } } },
        } as unknown as Awaited<ReturnType<Evaluator>>;
    };
}

const row: ListenCandidate = { id: "c0", label: "Delete everything", action: "press", element: 4 };

function session(risk: number, confirmRisk: "off" | "medium" | "high", pick: (ids: string[]) => string) {
    const acted: unknown[] = [];
    const view: ListenView = {
        app: "App",
        window: "w",
        snapshot: "tok",
        candidates: [row],
        rows: [{ id: "c0", role: "button", label: row.label }],
    };
    const pipeline = createListenPipeline({
        evaluate: chooser(pick, risk),
        chromeVerbs: false,
        confirmRisk,
        surface: {
            see: async () => view,
            act: async (payload) => {
                acted.push(payload);
                return { ok: true };
            },
        },
    });
    return { pipeline, acted };
}

const firstReal = (ids: string[]): string => ids.find((id) => id !== "abstain") ?? "abstain";
const yes = (ids: string[]): string => (ids.includes("confirm:yes") ? "confirm:yes" : firstReal(ids));
const no = (ids: string[]): string => (ids.includes("confirm:no") ? "confirm:no" : firstReal(ids));

describe("an irreversible act waits to be meant", () => {
    test("a high-risk act is held, and a spoken yes dispatches exactly what was held", async () => {
        const { pipeline, acted } = session(2, "high", yes);

        const held = await pipeline.decide(final("delete everything"));
        expect(held.status).toBe("hold");
        expect(held.reason).toBe("needs_confirmation");
        expect(acted).toEqual([]);

        const confirmed = await pipeline.decide(final("yes"));
        expect(confirmed.status).toBe("act");
        expect(confirmed.reason).toBe("confirmed");
        expect(acted).toEqual([{ element: 4, action: "press", uid: "c0" }]);
    });

    test("anything that is not a yes drops the held act", async () => {
        const { pipeline, acted } = session(2, "high", no);

        expect((await pipeline.decide(final("delete everything"))).status).toBe("hold");
        const dropped = await pipeline.decide(final("no"));
        expect(dropped.status).toBe("abstain");
        expect(dropped.reason).toBe("not_confirmed");
        expect(acted).toEqual([]);
    });

    test("below the floor, and with confirmation off, the act goes straight through", async () => {
        const low = session(0, "high", firstReal);
        expect((await low.pipeline.decide(final("delete everything"))).status).toBe("act");
        expect(low.acted).toHaveLength(1);

        const off = session(2, "off", firstReal);
        expect((await off.pipeline.decide(final("delete everything"))).status).toBe("act");
        expect(off.acted).toHaveLength(1);
    });

    test("medium is a lower bar than high: a send is held at medium and not at high", async () => {
        const atMedium = session(1, "medium", firstReal);
        expect((await atMedium.pipeline.decide(final("send it"))).status).toBe("hold");

        const atHigh = session(1, "high", firstReal);
        expect((await atHigh.pipeline.decide(final("send it"))).status).toBe("act");
    });
});
