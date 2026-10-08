import { describe, expect, it } from "bun:test";
import type { ActivityState } from "./activity";
import type { TurnSnapshot } from "./turn-state";
import { waitForTurn } from "./turn-wait";

function snap(state: ActivityState, lastEventAt: number | null): TurnSnapshot {
    return {
        state,
        lastText: `text@${lastEventAt}`,
        asksQuestion: false,
        interrupted: false,
        lastEventAt,
        lastActivityAt: 0,
        silenceMs: 0,
    };
}

/** A reader that returns one scripted snapshot per call, then repeats the last. */
function script(...snapshots: (TurnSnapshot | null)[]): { read: () => TurnSnapshot | null; calls: () => number } {
    let calls = 0;

    return {
        read: () => snapshots[Math.min(calls++, snapshots.length - 1)] ?? null,
        calls: () => calls,
    };
}

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;

    return {
        now: () => t,
        sleep: async (ms) => {
            t += ms;
        },
    };
}

describe("waitForTurn", () => {
    it("returns at once when the turn is already idle", async () => {
        const reader = script(snap("AWAITING-INPUT", 100));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastText).toBe("text@100");
        expect(result.waitedMs).toBe(0);
    });

    it("waits through RUNNING and returns when the turn ends", async () => {
        const reader = script(snap("RUNNING", 10), snap("RUNNING", 20), snap("AWAITING-INPUT", 30));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.waitedMs).toBe(2000);
    });

    it("reports STALLED without waiting out the timeout", async () => {
        const reader = script(snap("RUNNING", 10), snap("STALLED", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, timeoutMs: 60_000, ...clock() });

        expect(result.outcome).toBe("stalled");
        expect(result.waitedMs).toBe(1000);
    });

    it("times out on the deadline, sleeping no longer than what remains", async () => {
        const c = clock();
        const reader = script(snap("RUNNING", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, timeoutMs: 2500, ...c });

        expect(result.outcome).toBe("timeout");
        expect(result.waitedMs).toBe(2500);
        expect(result.snapshot?.state).toBe("RUNNING");
    });

    it("keeps waiting while the transcript is empty, and times out with no snapshot", async () => {
        const reader = script(null);
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, timeoutMs: 3000, ...clock() });

        expect(result.outcome).toBe("timeout");
        expect(result.snapshot).toBeNull();
    });

    it("with next, ignores the turn that was already finished and waits for a later one", async () => {
        const reader = script(
            snap("AWAITING-INPUT", 100),
            snap("AWAITING-INPUT", 100),
            snap("RUNNING", 150),
            snap("AWAITING-INPUT", 200)
        );
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastText).toBe("text@200");
        expect(result.waitedMs).toBe(2000);
    });

    it("with next, catches a turn that started and ended between two polls", async () => {
        const reader = script(snap("AWAITING-INPUT", 100), snap("AWAITING-INPUT", 100), snap("AWAITING-INPUT", 180));
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
        expect(result.snapshot?.lastEventAt).toBe(180);
    });

    it("with next on a running turn, returns when that turn ends", async () => {
        const reader = script(snap("RUNNING", 10), snap("RUNNING", 20), snap("AWAITING-INPUT", 30));
        const result = await waitForTurn({ read: reader.read, next: true, pollMs: 1000, ...clock() });

        expect(result.outcome).toBe("done");
    });

    it("stops at once when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const reader = script(snap("RUNNING", 10));
        const result = await waitForTurn({ read: reader.read, pollMs: 1000, signal: controller.signal, ...clock() });

        expect(result.outcome).toBe("timeout");
    });
});
