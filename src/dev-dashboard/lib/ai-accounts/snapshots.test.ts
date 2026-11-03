import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CLAUDE_ALL_ACCOUNT_ID } from "@app/dev-dashboard/contract/ai-accounts";
import { limitSeriesWire, spendAccountIds } from "@app/dev-dashboard/lib/ai-accounts/snapshots";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract/envelope";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { readLimitSeries } from "@genesiscz/utils/ai/usage-poll/series";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";

/** Invented handles, never a live account name. */
const ENABLED = [
    { id: "acc_work", provider: "anthropic-sub" },
    { id: "acc_personal", provider: "anthropic-sub" },
    { id: "acc_shop", provider: "grok-sub" },
];

describe("spendAccountIds", () => {
    test("no filter at all stays undefined, which means every account", () => {
        expect(spendAccountIds({}, ENABLED)).toBeUndefined();
    });

    test("an account filter alone passes straight through", () => {
        expect(spendAccountIds({ accounts: ["acc_shop"] }, ENABLED)).toEqual(["acc_shop"]);
    });

    test("a provider becomes its accounts, plus the claude pseudo account", () => {
        expect(spendAccountIds({ providers: ["anthropic-sub"] }, ENABLED)).toEqual([
            "acc_work",
            "acc_personal",
            CLAUDE_ALL_ACCOUNT_ID,
        ]);
    });

    test("a CLI alias resolves to the plugin id", () => {
        expect(spendAccountIds({ providers: ["claude"] }, ENABLED)).toEqual(
            spendAccountIds({ providers: ["anthropic-sub"] }, ENABLED)
        );
    });

    test("a provider with no configured account selects NOTHING, not everything", () => {
        expect(spendAccountIds({ providers: ["openai-sub"] }, ENABLED)).toEqual([]);
    });

    test("an unknown provider also selects nothing rather than falling through", () => {
        expect(spendAccountIds({ providers: ["nope"] }, ENABLED)).toEqual([]);
    });

    test("provider and account filters intersect", () => {
        expect(spendAccountIds({ providers: ["grok-sub"], accounts: ["acc_work"] }, ENABLED)).toEqual([]);
        expect(spendAccountIds({ providers: ["grok-sub"], accounts: ["acc_shop"] }, ENABLED)).toEqual(["acc_shop"]);
    });

    test("only the claude pseudo account survives a claude filter with no real claude account", () => {
        expect(spendAccountIds({ providers: ["claude"] }, [{ id: "acc_shop", provider: "grok-sub" }])).toEqual([
            CLAUDE_ALL_ACCOUNT_ID,
        ]);
    });
});
/**
 * Two providers may hold an account of the same NAME, and the limits DB is keyed
 * by provider AND name. The dashboard used to resolve each row through a
 * name-only map, so whichever account came last in config lent its id and its
 * provider to the other provider's history (eve review, PR #363). The mapping now
 * lives in the core (`readLimitSeries`); these pin it through the dashboard wire.
 */
describe("readLimitSeries through limitSeriesWire", () => {
    const FROM = "2026-11-01T00:00:00.000Z";
    const TO = "2026-11-01T12:00:00.000Z";
    const CLAUDE_WORK = { provider: "anthropic-sub", accountId: "acc_claude_work", accountName: "work" };
    const CODEX_WORK = { provider: "openai-sub", accountId: "acc_codex_work", accountName: "work" };
    const CURRENT: AccountUsageSnapshot[] = [
        {
            ...CLAUDE_WORK,
            fetchedAt: TO,
            limits: [{ key: "five_hour", label: "5h", kind: "session", percentUsed: 10 }],
        },
        {
            ...CODEX_WORK,
            fetchedAt: TO,
            limits: [{ key: "five_hour", label: "Session", kind: "session", percentUsed: 90 }],
        },
    ];
    let db: UsageLimitsDb;

    function put(provider: string, account: string, key: string, percent: number, at: string, kind = "session"): void {
        db.recordSnapshotV2(account, key, percent, at, {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider,
            kind,
        });
    }

    function wire(accounts?: AccountKey[]) {
        const data = readLimitSeries(
            { from: FROM, to: TO, agg: "last", ...(accounts ? { accounts } : {}) },
            { db, directory: [CLAUDE_WORK, CODEX_WORK], current: CURRENT }
        );

        return limitSeriesWire(data.series);
    }

    beforeEach(() => {
        db = new UsageLimitsDb(":memory:");
        put("anthropic-sub", "work", "five_hour", 10, "2026-11-01T01:00:00.000Z");
        put("openai-sub", "work", "five_hour", 90, "2026-11-01T01:00:00.000Z");
    });

    afterEach(() => {
        db.close();
    });

    test("each provider's history keeps its own account id, label and provider", () => {
        const series = wire();

        expect(series.map((s) => s.accountId)).toEqual(["acc_claude_work", "acc_codex_work"]);
        expect(series.map((s) => s.provider)).toEqual(["anthropic-sub", "openai-sub"]);
        expect(series.map((s) => s.label)).toEqual(["5h", "Session"]);
        expect(series.map((s) => s.points[0].percent)).toEqual([10, 90]);
    });

    test("selecting one of two same-named accounts drops the other provider's rows", () => {
        const series = wire([CODEX_WORK]);

        expect(series).toHaveLength(1);
        expect(series[0]).toMatchObject({ accountId: "acc_codex_work", provider: "openai-sub" });
    });

    test("a row with no configured account keeps its own provider and falls back to the name", () => {
        put("grok-sub", "side", "primary", 5, "2026-11-01T02:00:00.000Z", "weekly");

        expect(wire().find((s) => s.provider === "grok-sub")).toMatchObject({
            accountId: "side",
            accountName: "side",
            label: "primary",
        });
    });

    test("a window that changed kind stays one line on the wire, in time order", () => {
        put("anthropic-sub", "work", "five_hour", 40, "2026-11-01T03:00:00.000Z", "weekly");

        const claude = wire([CLAUDE_WORK]);

        expect(claude).toHaveLength(1);
        expect(claude[0].points.map((p) => p.percent)).toEqual([10, 40]);
        expect(claude[0].label).toBe("5h");
    });

    test("a window the newest poll lists as absent ends at its last point and keeps a readable label", () => {
        const current: AccountUsageSnapshot[] = [
            { ...CLAUDE_WORK, fetchedAt: TO, limits: [], absentLimits: [{ key: "five_hour", kind: "session" }] },
            CURRENT[1],
        ];
        const data = readLimitSeries(
            { from: FROM, to: TO, agg: "last" },
            { db, directory: [CLAUDE_WORK, CODEX_WORK], current }
        );
        const [claude, codex] = limitSeriesWire(data.series);

        expect(data.series.map((s) => s.availableNow)).toEqual(["absent", "limited"]);
        expect(claude).toMatchObject({
            provider: "anthropic-sub",
            endedAt: "2026-11-01T01:00:00.000Z",
            label: "Session (5h)",
        });
        expect(codex.endedAt).toBeUndefined();
    });

    test("forecastAt adds each window's forecast with the safe pace; without it the field stays null", () => {
        const at = new Date("2026-11-01T11:00:00.000Z");
        const reading = (percent: number, t: string) =>
            db.recordSnapshotV2("work", "five_hour", percent, t, {
                resetsAt: "2026-11-01T13:00:00.000Z",
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
                kind: "session",
            });
        reading(50, "2026-11-01T10:40:00.000Z");
        reading(60, "2026-11-01T10:59:00.000Z");
        const sources = { db, directory: [CLAUDE_WORK, CODEX_WORK], current: CURRENT };
        const request = { from: FROM, to: TO, agg: "raw" as const, accounts: [CODEX_WORK] };

        const [withForecast] = readLimitSeries({ ...request, forecastAt: at }, sources).series;
        const [plain] = readLimitSeries(request, sources).series;

        expect(withForecast.forecast).toMatchObject({ utilization: 60, safePctPerHour: 20 });
        expect(plain.forecast).toBeNull();
    });

    test("negative control: no selection returns every provider's history", () => {
        expect(wire()).toHaveLength(2);
    });
});
