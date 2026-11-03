import { describe, expect, test } from "bun:test";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import {
    bootstrapCI,
    ciOverlap,
    computeDrift,
    DRIFT_DEFAULTS,
    exclusiveWindows,
    pooled,
} from "@genesiscz/utils/ai/usage/drift/drift";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import type { SessionCall, SessionCompaction } from "../analysis-types";
import { callCostUsd } from "./cost";
import { buildSessionReport } from "./report";
import { sessionWaste } from "./waste";

/** The provider-neutral analysis over invented calls: the report, the waste items, and the drift statistics. */

const MODEL = "claude-sonnet-4-5";

function call(minute: number, extra: Partial<SessionCall> = {}): SessionCall {
    return {
        id: `c${minute}`,
        t: new Date(Date.UTC(2026, 10, 1, 10, minute)).toISOString(),
        model: MODEL,
        input: 100,
        cacheRead: 100_000,
        cacheWrite: 1_000,
        output: 500,
        sidechain: false,
        aggregate: false,
        ...extra,
    };
}

function waste(calls: SessionCall[], compactions: SessionCompaction[]) {
    return sessionWaste({ calls, compactions, agent: "claude" });
}

describe("session report", () => {
    test("totals, the main and sub-agent split, the tags of a cold call, and a cache loss after a long gap", () => {
        const calls = [
            call(0),
            call(1),
            call(2, { sidechain: true }),
            call(80, { cacheRead: 0, cacheWrite: 101_000, output: 40_000 }),
        ];
        const report = buildSessionReport({
            calls: { supported: true, items: calls },
            compactions: { supported: false, reason: "test harness keeps none" },
            agent: "claude",
        });

        expect(report.overview).toMatchObject({ calls: 4, subagentCalls: 1, compactions: null, durationMinutes: 80 });
        expect(report.cost.unpricedModels).toEqual([]);
        expect(report.cost.subagentUsd).toBeGreaterThan(0);
        expect(report.cost.totalUsd).toBeCloseTo(report.cost.mainUsd + report.cost.subagentUsd);
        expect(report.topCalls[0]?.tags).toEqual(["cold-cache", "large-cache-write", "very-high-output"]);
        expect(report.losses.map((loss) => loss.cause)).toEqual(["idle"]);
        expect(report.gaps).toEqual([{ after: calls[1].t, minutes: 79 }]);
        expect(report.unsupported).toEqual({ compactions: "test harness keeps none" });
    });

    test("waste prices a rebuild at write minus read and names its cause; a compaction is its own kind", () => {
        const items = waste(
            [call(0), call(1, { cacheRead: 0, cacheWrite: 101_000 }), call(70, { cacheRead: 0, cacheWrite: 101_000 })],
            [{ t: new Date(Date.UTC(2026, 10, 1, 10, 0, 30)).toISOString(), trigger: "auto", preTokens: 100_000 }]
        );

        expect(items.map((item) => [item.kind, item.tokens])).toEqual([["cache-rebuild-compaction", 100_000]]);
        expect(items[0]?.usd).toBeGreaterThan(0);
    });

    test("a compaction to a short summary costs the summary it wrote, not the reads it dropped", () => {
        const compacted = [
            { t: new Date(Date.UTC(2026, 10, 1, 10, 0, 30)).toISOString(), trigger: "auto", preTokens: 100_000 },
        ];
        const items = waste([call(0), call(1, { input: 0, cacheRead: 0, cacheWrite: 5_000 })], compacted);

        expect(items.map((item) => [item.kind, item.tokens])).toEqual([["cache-rebuild-compaction", 5_000]]);
    });

    test("aggregate rows are no cache loss, and a one-hour write survives a ten-minute gap", () => {
        const aggregate = [call(0, { aggregate: true }), call(1, { aggregate: true, cacheRead: 2_000, cacheWrite: 0 })];
        const report = buildSessionReport({
            calls: { supported: true, items: aggregate },
            compactions: { supported: false, reason: "none" },
            agent: "claude",
        });

        expect(waste(aggregate, [])).toEqual([]);
        expect(report.losses).toEqual([]);
        // Their tokens still count in the cache totals and the hit rate (a Grok session is all aggregate turns).
        expect(report.cache).toMatchObject({ requests: 2, cacheRead: 102_000, cacheWrite: 1_000, uncached: 200 });
        expect(report.cache.hitPercent).toBeGreaterThan(90);

        const hour = [call(0, { cacheWrite1h: 1_000 }), call(10, { cacheRead: 0, cacheWrite: 101_000 })];
        expect(waste(hour, []).map((item) => item.kind)).not.toContain("cache-rebuild-idle");
        expect(waste([call(0), call(10, { cacheRead: 0, cacheWrite: 101_000 })], []).map((i) => i.kind)).toEqual([
            "cache-rebuild-idle",
        ]);
    });

    test("a sub-agent's own transcript is scanned as its own cache; sidechain calls inside a lead are not", () => {
        const own = [call(0, { sidechain: true }), call(10, { sidechain: true, cacheRead: 0, cacheWrite: 101_000 })];
        expect(waste(own, []).map((item) => item.kind)).toEqual(["cache-rebuild-idle"]);

        const lead = [
            call(0),
            call(1, { sidechain: true }),
            call(10, { sidechain: true, cacheRead: 0, cacheWrite: 101_000 }),
        ];
        expect(waste(lead, [])).toEqual([]);
    });

    test("a priority call is priced at its service tier, as the spend reports price it", () => {
        const standard = callCostUsd(call(0, { model: "grok-4.7", cacheRead: 0 }), { agent: "grok" });
        const priority = callCostUsd(call(0, { model: "grok-4.7", cacheRead: 0, serviceTier: "priority" }), {
            agent: "grok",
        });

        expect(standard).not.toBeNull();
        expect(priority ?? 0).toBeGreaterThan(standard ?? 0);
    });

    test("a call is priced through its harness's candidate ladder, as the spend reports price it", () => {
        const build = call(0, { model: "grok-4.6-build", cacheRead: 0 });
        const base = call(0, { model: "grok-4.6", cacheRead: 0 });
        const report = buildSessionReport({
            calls: { supported: true, items: [build] },
            compactions: { supported: false, reason: "none" },
            agent: "grok",
        });

        expect(callCostUsd(build, { agent: "grok" })).not.toBeNull();
        expect(callCostUsd(build, { agent: "grok" })).toBe(callCostUsd(base, { agent: "grok" }));
        expect(report.cost.unpricedModels).toEqual([]);
    });
});

describe("limit drift", () => {
    test("an exclusive window is a rise of the target with no other account rising around it", () => {
        const rows = [
            { ts: 0, account: "a", series: "a", util: 10, resetsAt: null },
            { ts: 0, account: "b", series: "b", util: 5, resetsAt: null },
            { ts: 60_000, account: "a", series: "a", util: 11, resetsAt: null },
            { ts: 120_000, account: "b", series: "b", util: 6, resetsAt: null },
            { ts: 600_000, account: "a", series: "a", util: 13, resetsAt: null },
        ];

        expect(
            exclusiveWindows(rows, { account: "a", series: "a" }, { padMs: 30_000, maxWindowMs: 3_600_000 })
        ).toEqual([{ from: 0, to: 60_000, delta: 1 }]);
    });

    test("a rise across a reset is no window: 2 % before and 8 % after are two windows, not six points", () => {
        const week = 7 * 24 * 3_600_000;
        const opts = { padMs: 30_000, maxWindowMs: 3_600_000 };
        const target = { account: "a", series: "a" };
        // The reset at 30 s falls between the polls; the new window ends higher than the old one.
        const passed = [
            { ts: 0, account: "a", series: "a", util: 2, resetsAt: 30_000 },
            { ts: 60_000, account: "a", series: "a", util: 8, resetsAt: 30_000 + week },
        ];
        // The provider moved the reset forward (an early reset) without the old instant having passed.
        const moved = [
            { ts: 0, account: "a", series: "a", util: 2, resetsAt: week },
            { ts: 60_000, account: "a", series: "a", util: 8, resetsAt: 60_000 + week },
        ];
        // The same reset instant read again a few seconds apart is still one window.
        const same = [
            { ts: 0, account: "a", series: "a", util: 2, resetsAt: week },
            { ts: 60_000, account: "a", series: "a", util: 8, resetsAt: week + 2_000 },
        ];

        expect(exclusiveWindows(passed, target, opts)).toEqual([]);
        expect(exclusiveWindows(moved, target, opts)).toEqual([]);
        expect(exclusiveWindows(same, target, opts)).toEqual([{ from: 0, to: 60_000, delta: 6 }]);
    });

    test("pooled ratio, a deterministic interval, and the overlap test", () => {
        const samples = [
            { delta: 1, value: 100 },
            { delta: 2, value: 220 },
            { delta: 1, value: 90 },
        ];

        expect(pooled(samples)).toBe(102.5);
        expect(bootstrapCI(samples)).toEqual(bootstrapCI(samples));
        expect(ciOverlap([1, 2], [3, 4])).toBe(false);
        expect(ciOverlap([1, 3], [2, 4])).toBe(true);
    });

    test("computeDrift counts one week's exclusive windows and calls a week with too few insufficient", () => {
        const series: SeriesEntry = {
            provider: "anthropic-sub",
            account: "work",
            key: "seven_day",
            kind: "weekly",
            scopeModel: null,
            resets: [],
            availability: [],
            points: [0, 10, 20, 30].map((minute, index) => ({
                t: new Date(Date.UTC(2026, 10, 2, 10, minute)).toISOString(),
                percent: 10 + index,
                resetsAt: null,
                severity: null,
            })),
        };
        const event = (minute: number): AttributedEvent => ({
            at: Date.UTC(2026, 10, 2, 10, minute),
            costUsd: 1,
            tokens: 1000,
            unpriced: false,
            model: MODEL,
            provider: "anthropic-sub",
            agent: "claude",
            file: "/fixture/s.jsonl",
            owner: { sessionId: "s", leadSessionId: "s", subagent: false, project: "-repo" },
            account: {
                account: { provider: "anthropic-sub", accountId: "w", accountName: "work" },
                basis: "pin",
                approximate: true,
            },
        });
        const rows = computeDrift({
            series: [series],
            events: [event(5), event(15), event(25)],
            accountOf: () => ({ provider: "anthropic-sub", accountId: "w", accountName: "work" }),
            settings: { ...DRIFT_DEFAULTS, minWindows: 3 },
            tz: "UTC",
        });

        expect(rows.map((row) => [row.model, row.weeks[0]?.windows, row.weeks[0]?.tokensPerPct, row.verdict])).toEqual([
            ["all", 3, 1000, "steady"],
            [MODEL, 3, 1000, "steady"],
        ]);
        expect(
            computeDrift({
                series: [series],
                events: [event(5)],
                accountOf: () => rows[0].account,
                settings: DRIFT_DEFAULTS,
                tz: "UTC",
            })[0]?.verdict
        ).toBe("insufficient");
    });
});
