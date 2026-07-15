import { describe, expect, test } from "bun:test";
import { createPartialThrottle } from "@app/youtube/lib/partial-throttle";

// Bun's test runner has no fake timers, so per the plan's ON-FAIL clause these
// tests run against real timers with a small minGapMs — behaviour, not
// wall-clock, is the contract. A small epsilon absorbs setTimeout jitter.
const MIN_GAP_MS = 40;
const EPSILON_MS = 2;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Emission<T> {
    value: T;
    at: number;
}

function collector<T>() {
    const emissions: Emission<T>[] = [];
    return {
        emissions,
        emit: (value: T) => emissions.push({ value, at: Date.now() }),
    };
}

describe("createPartialThrottle", () => {
    test("first push emits immediately", () => {
        const { emissions, emit } = collector<string>();
        const throttle = createPartialThrottle({ minGapMs: MIN_GAP_MS, emit });

        throttle.push("a");

        expect(emissions.map((e) => e.value)).toEqual(["a"]);
    });

    test("rapid pushes emit latest-wins with gaps ≥ minGapMs", async () => {
        const { emissions, emit } = collector<string>();
        const throttle = createPartialThrottle({ minGapMs: MIN_GAP_MS, emit });

        throttle.push("a");
        throttle.push("b");
        throttle.push("c");
        await sleep(MIN_GAP_MS * 2);

        expect(emissions.map((e) => e.value)).toEqual(["a", "c"]);
        const gap = emissions[1].at - emissions[0].at;
        expect(gap).toBeGreaterThanOrEqual(MIN_GAP_MS - EPSILON_MS);
    });

    test("flush delivers the pending value exactly once", async () => {
        const { emissions, emit } = collector<string>();
        const throttle = createPartialThrottle({ minGapMs: MIN_GAP_MS, emit });

        throttle.push("a");
        throttle.push("b");
        throttle.flush();

        expect(emissions.map((e) => e.value)).toEqual(["a", "b"]);

        throttle.flush();
        await sleep(MIN_GAP_MS * 2);

        expect(emissions.map((e) => e.value)).toEqual(["a", "b"]);
    });

    test("flush right after a timed emission does not re-emit", async () => {
        const { emissions, emit } = collector<string>();
        const throttle = createPartialThrottle({ minGapMs: MIN_GAP_MS, emit });

        throttle.push("a");
        throttle.push("b");
        await sleep(MIN_GAP_MS * 2);

        expect(emissions.map((e) => e.value)).toEqual(["a", "b"]);

        throttle.flush();

        expect(emissions.map((e) => e.value)).toEqual(["a", "b"]);
    });

    test("push after a full gap emits immediately again", async () => {
        const { emissions, emit } = collector<string>();
        const throttle = createPartialThrottle({ minGapMs: MIN_GAP_MS, emit });

        throttle.push("a");
        await sleep(MIN_GAP_MS + 10);
        throttle.push("b");

        expect(emissions.map((e) => e.value)).toEqual(["a", "b"]);
    });
});
