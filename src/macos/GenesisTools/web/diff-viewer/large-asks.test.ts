import { describe, expect, test } from "bun:test";
import { createLargeAsks, LARGE_ASK_DEADLINE_MS } from "./large-asks";

/** Fake timers: `advance(ms)` runs every timer that is due by then. */
function harness(deadlineMs?: number) {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; run: () => void }>();
    const ended: string[] = [];
    const logs: string[] = [];
    const asks = createLargeAsks({
        log: (message) => logs.push(message),
        setTimeout: (run, ms) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, run });
            return id;
        },
        clearTimeout: (id) => {
            timers.delete(id);
        },
        onEnd: (fileId) => ended.push(fileId),
        deadlineMs,
    });

    function advance(ms: number): void {
        now += ms;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now) {
                timers.delete(id);
                timer.run();
            }
        }
    }

    return { asks, advance, ended, logs, timers };
}

describe("createLargeAsks", () => {
    test("one ask per file: a second click while it is open asks nothing", () => {
        const { asks } = harness();

        expect(asks.ask("big.json")).toBe(true);
        expect(asks.isAsked("big.json")).toBe(true);
        expect(asks.ask("big.json")).toBe(false);
        expect(asks.ask("other.json")).toBe(true);
    });

    test("a host refusal ends the ask, says why, and lets the reader ask again", () => {
        const { asks, ended, timers } = harness();
        asks.ask("big.json");

        expect(asks.failed("big.json", "git show failed")).toBe(true);
        expect(asks.isAsked("big.json")).toBe(false);
        expect(asks.lastFailure("big.json")).toBe("git show failed");
        expect(ended).toEqual(["big.json"]);
        expect(timers.size).toBe(0);
        expect(asks.ask("big.json")).toBe(true);
        expect(asks.lastFailure("big.json")).toBeUndefined();
    });

    test("an ask with no answer ends at the deadline, so the button never stays on Loading…", () => {
        const { asks, advance, ended, logs } = harness();
        asks.ask("big.json");

        advance(LARGE_ASK_DEADLINE_MS - 1);
        expect(asks.isAsked("big.json")).toBe(true);
        advance(1);
        expect(asks.isAsked("big.json")).toBe(false);
        expect(asks.lastFailure("big.json")).toBe("no answer in 60 s");
        expect(ended).toEqual(["big.json"]);
        expect(logs).toEqual(["diff.large ask for big.json ended without the file: no answer in 60 s"]);
    });

    test("the file's arrival ends the ask quietly and cancels its deadline", () => {
        const { asks, advance, ended, timers } = harness(1000);
        asks.ask("big.json");

        asks.arrived("big.json");
        advance(5000);
        expect(asks.isAsked("big.json")).toBe(false);
        expect(asks.lastFailure("big.json")).toBeUndefined();
        expect(ended).toEqual([]);
        expect(timers.size).toBe(0);
    });

    test("a stale or unrelated reply changes nothing", () => {
        const { asks, ended } = harness();
        asks.ask("big.json");

        expect(asks.failed("other.json", "late")).toBe(false);
        expect(asks.isAsked("big.json")).toBe(true);
        asks.arrived("big.json");
        expect(asks.failed("big.json", "late")).toBe(false);
        expect(asks.lastFailure("big.json")).toBeUndefined();
        expect(ended).toEqual([]);
    });
});
