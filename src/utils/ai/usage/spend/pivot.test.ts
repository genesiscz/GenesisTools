import { describe, expect, test } from "bun:test";
import { callCostUsd, coldRebuildUsd } from "@genesiscz/utils/agent-sessions/analysis/cost";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { NO_ACCOUNT, pivotSpend } from "./pivot";
import { cycleOf, planValues } from "./plans";
import type { PricingTable } from "./types";

const WORK = { provider: "anthropic-sub", accountId: "acc-work", accountName: "work" };

function event(at: string, usd: number, extra: Partial<AttributedEvent> = {}): AttributedEvent {
    return {
        at: Date.parse(at),
        costUsd: usd,
        tokens: usd * 100,
        unpriced: false,
        model: "m-a",
        provider: "anthropic-sub",
        agent: "claude",
        file: "/fixture/s1.jsonl",
        owner: { sessionId: "s1", leadSessionId: "s1", subagent: false, project: "-repo" },
        account: { account: WORK, basis: "pin", approximate: true },
        ...extra,
    };
}

describe("pivotSpend", () => {
    test("splits by account and model into local day buckets, an unpinned session under (no account)", () => {
        const pivot = pivotSpend({
            events: [
                event("2026-11-01T10:00:00Z", 2),
                event("2026-11-01T23:30:00Z", 1),
                event("2026-11-02T08:00:00Z", 4, { account: { basis: "none", approximate: false }, model: "m-b" }),
                event("2026-11-09T08:00:00Z", 50),
            ],
            from: Date.parse("2026-11-01T00:00:00Z"),
            to: Date.parse("2026-11-08T00:00:00Z"),
            grain: "day",
            tz: "UTC",
            by: ["account", "model"],
            heatmap: true,
        });

        expect(pivot.groups.map((g) => [g.key.account, g.key.model, g.costUsd, g.points.map((p) => p.t)])).toEqual([
            [NO_ACCOUNT, "m-b", 4, ["2026-11-02"]],
            ["work", "m-a", 3, ["2026-11-01"]],
        ]);
        expect(pivot.total.costUsd).toBe(7);
        // 2026-11-01 is a Sunday (row 6); one week in range, so the cell is the plain sum.
        expect(pivot.heatmap?.cells[6][10]).toBe(2);
    });
});

describe("planValues", () => {
    test("the cycle runs one month back from the renewal day; spend, capacity and paid-back come from it", () => {
        const now = new Date("2026-11-03T12:00:00Z");
        const snapshot: AccountUsageSnapshot = {
            ...WORK,
            fetchedAt: now.toISOString(),
            limits: [],
            plan: { name: "max", renewsAt: "2026-11-06" },
        };
        const weekly: SeriesEntry = {
            provider: "anthropic-sub",
            account: "work",
            key: "seven_day",
            kind: "weekly",
            scopeModel: null,
            resets: [],
            availability: [],
            points: [
                { t: "2026-10-10T00:00:00Z", percent: 10, resetsAt: null, severity: null },
                { t: "2026-10-12T00:00:00Z", percent: 50, resetsAt: null, severity: null },
                { t: "2026-10-20T00:00:00Z", percent: 5, resetsAt: null, severity: null },
                { t: "2026-10-22T00:00:00Z", percent: 45, resetsAt: null, severity: null },
            ],
        };

        expect(cycleOf(snapshot.plan, now)).toEqual({
            from: "2026-10-06T00:00:00.000Z",
            to: "2026-11-06T00:00:00.000Z",
            guessed: false,
        });

        const [value] = planValues({
            snapshots: [snapshot],
            events: [event("2026-10-15T00:00:00Z", 400), event("2026-10-01T00:00:00Z", 999)],
            weekly: [weekly],
            providers: { "anthropic-sub": { plans: { max: { priceMinor: 20_000, currency: "USD" } } } },
            now,
        });

        expect(value?.spendUsd).toBe(400);
        expect(value?.paidBackX).toBe(2);
        expect(value?.weeklyRisePct).toBe(80);
        expect(value?.usdPerWeeklyPoint).toBe(5);
        expect(value?.renewsInDays).toBe(3);
    });
});

describe("cycleOf", () => {
    test("one calendar month back, the day clamped to the shorter month", () => {
        const now = new Date("2026-03-15T00:00:00Z");
        const from = (renewsAt: string) => cycleOf({ renewsAt }, now).from.slice(0, 10);

        expect(from("2027-03-31")).toBe("2027-02-28");
        expect(from("2028-03-30")).toBe("2028-02-29");
        expect(from("2026-03-29")).toBe("2026-02-28");
        expect(from("2026-05-31")).toBe("2026-04-30");
        expect(from("2026-07-31")).toBe("2026-06-30");
        expect(from("2026-01-31")).toBe("2025-12-31");
        expect(from("2026-11-06")).toBe("2026-10-06");
    });
});

describe("call cost", () => {
    const pricing: PricingTable = {
        "m-a": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, cacheWrite1h: 6 },
    };

    test("a call is priced at its own rates per token kind; an unknown model has no price", () => {
        const call = {
            id: "c1",
            t: "2026-11-01T10:00:00Z",
            model: "m-a",
            input: 1_000_000,
            cacheRead: 1_000_000,
            cacheWrite: 0,
            output: 1_000_000,
            sidechain: false,
            aggregate: false,
        };

        expect(callCostUsd(call, pricing)).toBeCloseTo(3 + 0.3 + 15);
        expect(callCostUsd({ ...call, model: "m-unknown" }, pricing)).toBeNull();
    });

    test("an aggregate row takes no long-context band; one request of the same size does", () => {
        const banded: PricingTable = {
            "m-long": {
                input: 2,
                output: 10,
                cacheWrite: 2.5,
                cacheRead: 0.2,
                rules: [{ ctxFrom: 200_000, inputPer1M: 4, outputPer1M: 20 }],
            },
        };
        const call = {
            id: "c2",
            t: "2026-11-01T10:00:00Z",
            model: "m-long",
            input: 300_000,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            sidechain: false,
            aggregate: true,
        };

        expect(callCostUsd(call, banded)).toBeCloseTo(0.6);
        expect(callCostUsd({ ...call, aggregate: false }, banded)).toBeCloseTo(1.2);
    });

    test("going cold costs the context at the write rate of its tier minus the read rate", () => {
        const at = new Date("2026-11-01T10:00:00Z");

        expect(coldRebuildUsd({ model: "m-a", contextTokens: 100_000, oneHour: true, at, pricing })).toBeCloseTo(0.57);
        expect(coldRebuildUsd({ model: "m-a", contextTokens: 100_000, oneHour: false, at, pricing })).toBeCloseTo(
            0.345
        );
    });
});
