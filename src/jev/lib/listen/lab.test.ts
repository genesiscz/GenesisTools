import { expect, test } from "bun:test";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import {
    LISTEN_LAB_DEFAULT_FIXTURE,
    ListenLab,
    ListenSessionConflictError,
    listenLabObservation,
    resolveLabTarget,
} from "./lab";

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

/** Picks the first observed press candidate, which is the fixture calculator's `7` button. */
function chooser(choice: string, mass = 0.94): Evaluator {
    // Six observed press candidates, the five chrome verbs the pipeline always offers, and abstain.
    const keys = ["c0", "c1", "c2", "c3", "c4", "c5", "back", "next_tab", "prev_tab", "close_tab", "reload", "abstain"];
    const rest = (1 - mass) / (keys.length - 1);
    return async () =>
        evaluation({
            verb: {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? mass : rest])),
            },
            terminal: { type: "boolean", probability: 0.96 },
            correction: { type: "boolean", probability: 0.01 },
        });
}

test("the fixture observation offers the calculator buttons as press candidates", () => {
    const observation = listenLabObservation();
    expect(observation.elements.filter((row) => row.actions?.includes("AXPress"))).toHaveLength(6);
    expect(observation.app).toBe("FixtureCalculator");
});

test("a second listen start is a conflict while the first is running", async () => {
    const lab = new ListenLab();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const slow: Evaluator = async (call) => {
        await blocked;
        return chooser("c0")(call);
    };
    lab.start({ evaluate: slow });
    expect(() => lab.start({ evaluate: slow })).toThrow(ListenSessionConflictError);
    release();
    await lab.settle();
    expect(lab.status().running).toBe(false);
    lab.dispose();
});

test("start runs the real pipeline and appends every decision to the tail", async () => {
    const lab = new ListenLab();
    expect(lab.tail()).toEqual([]);
    const started = lab.start({ fixture: LISTEN_LAB_DEFAULT_FIXTURE, evaluate: chooser("c0") });
    expect(started.running).toBe(true);
    expect(started.transcript).toBe(LISTEN_LAB_DEFAULT_FIXTURE);
    expect(started.dryRun).toBe(true);
    await lab.settle();

    const tail = lab.tail();
    expect(tail).toHaveLength(4);
    expect(tail.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(tail.at(-1)?.status).toBe("stop");
    const pressed = tail.filter((row) => row.choice === "c0");
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed[0].status).toBe("would");
    expect(pressed[0].reason).toBe("dry_run");
    expect(pressed[0].probability).toBeGreaterThan(0.9);
    // The last row is `stop`, so the strip reports the newest row that named a target.
    expect(lab.status().wouldPress).toBe("c0");
    lab.dispose();
});

test("an uncertain chooser leaves nothing to press", async () => {
    const lab = new ListenLab();
    // 0.4 is under the 0.8 admission gate, so nothing is admitted and nothing would be pressed.
    lab.start({ fixture: "calculator-ambiguous", evaluate: chooser("c0", 0.4) });
    await lab.settle();
    const tail = lab.tail();
    expect(tail).toHaveLength(2);
    expect(tail[0].status).toBe("abstain");
    expect(lab.status().wouldPress).toBeNull();
    lab.dispose();
});

test("a session may start again once the previous one finished", async () => {
    const lab = new ListenLab();
    lab.start({ evaluate: chooser("c0") });
    await lab.settle();
    expect(() => lab.start({ evaluate: chooser("c0") })).not.toThrow();
    await lab.settle();
    expect(lab.tail()).toHaveLength(4);
    lab.dispose();
});

test("an unknown fixture names the ones that exist", () => {
    const lab = new ListenLab();
    expect(() => lab.start({ fixture: "not-a-fixture" })).toThrow(/calculator-press-seven/);
    lab.dispose();
});

test("stop ends the session", async () => {
    const lab = new ListenLab();
    lab.start({ evaluate: chooser("c0") });
    expect(lab.stop().running).toBe(false);
    await lab.settle();
    lab.dispose();
});

test("a native app target needs a loopback request, and act still needs that app", () => {
    expect(() => resolveLabTarget({ app: "Calculator" })).toThrow(/loopback/);
    expect(resolveLabTarget({ app: "Calculator", allowNative: true })).toEqual({
        app: "Calculator",
        dryRun: true,
    });
    // Negative control: the guard must not break the path it is meant to allow.
    expect(resolveLabTarget({ app: "Calculator", allowNative: true, act: true })).toEqual({
        app: "Calculator",
        dryRun: false,
    });
    expect(resolveLabTarget({ act: true, allowNative: true })).toEqual({ dryRun: true });
});
