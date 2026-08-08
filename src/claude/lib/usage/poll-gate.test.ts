import { describe, expect, test } from "bun:test";
import {
    backoffMs,
    blockedEntry,
    MAX_BACKOFF_MS,
    type PollGate,
    pruneGate,
    recordFailure,
    recordSuccess,
} from "./poll-gate";

const NOW = 1_800_000_000_000;

describe("backoffMs", () => {
    test("the first failure never blocks — one 429 is routine", () => {
        expect(backoffMs(1)).toBe(0);
    });

    test("climbs with consecutive failures", () => {
        expect(backoffMs(2)).toBe(5 * 60_000);
        expect(backoffMs(3)).toBe(30 * 60_000);
        expect(backoffMs(4)).toBe(2 * 3_600_000);
    });

    test("caps instead of growing forever", () => {
        expect(backoffMs(5)).toBe(MAX_BACKOFF_MS);
        expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    });
});

describe("recordFailure", () => {
    test("a single failure leaves the account pollable", () => {
        const gate = recordFailure({}, "a", "Usage API 429", NOW);
        expect(gate.a.failures).toBe(1);
        expect(blockedEntry(gate, "a", NOW)).toBeNull();
    });

    test("the second consecutive failure blocks for 5 minutes", () => {
        let gate = recordFailure({}, "a", "Usage API 429", NOW);
        gate = recordFailure(gate, "a", "Usage API 429", NOW);

        expect(blockedEntry(gate, "a", NOW)?.reason).toBe("Usage API 429");
        expect(blockedEntry(gate, "a", NOW + 5 * 60_000)).toBeNull();
    });

    test("a dead account converges on the 6h cap", () => {
        let gate: PollGate = {};

        for (let i = 0; i < 8; i++) {
            gate = recordFailure(gate, "dead", "invalid_grant", NOW);
        }

        expect(gate.dead.blockedUntil - NOW).toBe(MAX_BACKOFF_MS);
    });

    test("does not mutate the gate it was given", () => {
        const original: PollGate = {};
        recordFailure(original, "a", "boom", NOW);
        expect(original.a).toBeUndefined();
    });
});

describe("recordSuccess", () => {
    test("clears the backoff so the next poll runs immediately", () => {
        let gate = recordFailure({}, "a", "Usage API 429", NOW);
        gate = recordFailure(gate, "a", "Usage API 429", NOW);
        gate = recordSuccess(gate, "a");

        expect(gate.a).toBeUndefined();
        expect(blockedEntry(gate, "a", NOW)).toBeNull();
    });

    test("returns the same object when there was nothing to clear", () => {
        const gate: PollGate = {};
        expect(recordSuccess(gate, "a")).toBe(gate);
    });
});

describe("pruneGate", () => {
    test("forgets accounts that are no longer configured", () => {
        const gate = recordFailure(recordFailure({}, "gone", "x", NOW), "kept", "y", NOW);
        const pruned = pruneGate(gate, ["kept"]);

        expect(Object.keys(pruned)).toEqual(["kept"]);
    });
});
