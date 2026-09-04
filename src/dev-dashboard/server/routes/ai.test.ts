import { describe, expect, it } from "bun:test";
import type {
    AccountUsageSnapshot,
    AiAccountsResult,
    AiDaemonStatus,
    AiSpendSeriesResult,
    AiSpendTotalsResult,
    AiUsageResult,
    AiUsageSeriesResult,
} from "@app/dev-dashboard/contract/ai-accounts";
import type {
    AiAggregator,
    SpendSeriesQuery,
    SpendTotalsQuery,
    UsageSeriesQuery,
} from "@app/dev-dashboard/lib/ai-accounts/aggregator";
import { filterSnapshots, type SnapshotFilter } from "@app/dev-dashboard/lib/ai-accounts/snapshots";
import { aiRoutes } from "@app/dev-dashboard/server/routes/ai";
import { claudeRoutes } from "@app/dev-dashboard/server/routes/claude";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@genesiscz/utils/json";

/** Invented handles, never a live account name. */
function snapshot(provider: string, accountName: string): AccountUsageSnapshot {
    return {
        provider,
        accountId: `acc_${accountName}`,
        accountName,
        fetchedAt: "2026-09-04T12:00:00.000Z",
        limits: [{ key: "five_hour", label: "5h", kind: "session", percentUsed: 42 }],
    };
}

const SNAPSHOTS = [snapshot("anthropic-sub", "work"), snapshot("grok-sub", "personal")];

interface Calls {
    listAccounts: number;
    getCurrentSnapshots: SnapshotFilter[];
    refreshSnapshots: SnapshotFilter[];
    getUsageSeries: UsageSeriesQuery[];
    getSpendTotals: SpendTotalsQuery[];
    getSpendSeries: SpendSeriesQuery[];
    getAiDaemonStatus: number;
    registerAiDaemon: number;
}

function fakeAggregator(): { agg: AiAggregator; calls: Calls } {
    const calls: Calls = {
        listAccounts: 0,
        getCurrentSnapshots: [],
        refreshSnapshots: [],
        getUsageSeries: [],
        getSpendTotals: [],
        getSpendSeries: [],
        getAiDaemonStatus: 0,
        registerAiDaemon: 0,
    };

    const agg: AiAggregator = {
        async listAccounts(): Promise<AiAccountsResult> {
            calls.listAccounts += 1;
            return {
                accounts: [
                    {
                        id: "acc_work",
                        name: "work",
                        provider: "anthropic-sub",
                        alias: "claude",
                        enabled: true,
                        hasUsage: true,
                        hasSpendScope: true,
                        credentialKinds: ["accessToken"],
                    },
                ],
            };
        },

        async getCurrentSnapshots(filter): Promise<AiUsageResult> {
            calls.getCurrentSnapshots.push(filter);
            return { fetchedAt: "2026-09-04T12:00:00.000Z", snapshots: filterSnapshots(SNAPSHOTS, filter) };
        },

        async refreshSnapshots(filter): Promise<AiUsageResult> {
            calls.refreshSnapshots.push(filter);
            return { fetchedAt: "2026-09-04T12:05:00.000Z", snapshots: filterSnapshots(SNAPSHOTS, filter) };
        },

        async getUsageSeries(query): Promise<AiUsageSeriesResult> {
            calls.getUsageSeries.push(query);
            return { series: [] };
        },

        async getSpendTotals(query): Promise<AiSpendTotalsResult> {
            calls.getSpendTotals.push(query);
            return {
                from: query.from,
                to: query.to,
                source: query.source,
                total: { costUsd: 1.5, tokens: 100 },
                accounts: [],
                unpriced: 0,
            };
        },

        async getSpendSeries(query): Promise<AiSpendSeriesResult> {
            calls.getSpendSeries.push(query);
            return {
                from: query.from,
                to: query.to,
                grain: query.grain,
                source: query.source,
                points: [],
                accounts: [],
                unpriced: 0,
            };
        },

        async getAiDaemonStatus(): Promise<AiDaemonStatus> {
            calls.getAiDaemonStatus += 1;
            return { registered: true, taskName: "ai-usage-poll", perProvider: {} };
        },

        async registerAiDaemon(): Promise<{ ok: boolean }> {
            calls.registerAiDaemon += 1;
            return { ok: true };
        },
    };

    return { agg, calls };
}

function findRoute(defs: RouteDef[], method: string, pattern: string): RouteDef {
    const def = defs.find((d) => d.method === method && d.pattern === pattern);

    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }

    return def;
}

function makeCtx(query: Record<string, string> = {}): RouteContext {
    return {
        method: "GET",
        pathname: "/api/ai/usage",
        query: new URLSearchParams(query),
        params: {},
        headers: {},
        readJson: async <T>() => ({}) as T,
        readRawBody: async () => new TextEncoder().encode(SafeJSON.stringify({})),
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected json result, got ${result.kind}`);
    }

    return { status: result.status, body: result.body as Record<string, unknown> };
}

async function call(
    defs: RouteDef[],
    method: string,
    pattern: string,
    query: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
    return asJson(await findRoute(defs, method, pattern).handler(makeCtx(query)));
}

describe("aiRoutes", () => {
    it("registers every path in AI_ACCOUNTS_API", () => {
        const { agg } = fakeAggregator();
        const paths = aiRoutes(agg).map((d) => `${d.method} ${d.pattern}`);

        expect(paths).toEqual([
            "GET /api/ai/accounts",
            "GET /api/ai/usage",
            "POST /api/ai/usage/refresh",
            "GET /api/ai/usage/series",
            "GET /api/ai/spend/totals",
            "GET /api/ai/spend/series",
            "GET /api/ai/daemon",
            "POST /api/ai/daemon/register",
        ]);
    });

    it("400s on an unparseable from, and names the field", async () => {
        const { agg, calls } = fakeAggregator();
        const { status, body } = await call(aiRoutes(agg), "GET", "/api/ai/spend/totals", {
            from: "not-a-date",
            to: "2026-09-04T12:00:00.000Z",
        });

        expect(status).toBe(400);
        expect(String(body.error)).toContain("from");
        expect(String(body.error)).toContain("ISO-8601");
        // The aggregator must never see a query the route rejected.
        expect(calls.getSpendTotals).toHaveLength(0);
    });

    it("400s on an unparseable to", async () => {
        const { agg } = fakeAggregator();
        const { status, body } = await call(aiRoutes(agg), "GET", "/api/ai/usage/series", {
            from: "2026-09-04T11:00:00.000Z",
            to: "yesterday",
        });

        expect(status).toBe(400);
        expect(String(body.error)).toContain("to");
    });

    it("negative control: a valid ISO pair reaches the aggregator and returns 200", async () => {
        const { agg, calls } = fakeAggregator();
        const { status, body } = await call(aiRoutes(agg), "GET", "/api/ai/spend/totals", {
            from: "2026-09-04T11:00:00.000Z",
            to: "2026-09-04T12:00:00.000Z",
        });

        expect(status).toBe(200);
        expect(body.total).toEqual({ costUsd: 1.5, tokens: 100 });
        expect(calls.getSpendTotals).toHaveLength(1);
        // D5: transcripts is the default source.
        expect(calls.getSpendTotals[0].source).toBe("transcripts");
    });

    it("clamps a future `to` down to now", async () => {
        const { agg, calls } = fakeAggregator();
        const future = new Date(Date.now() + 86_400_000).toISOString();
        const { status } = await call(aiRoutes(agg), "GET", "/api/ai/spend/series", {
            from: "2026-09-04T11:00:00.000Z",
            to: future,
            grain: "hour",
        });

        expect(status).toBe(200);
        expect(Date.parse(calls.getSpendSeries[0].to)).toBeLessThan(Date.parse(future));
        expect(Date.parse(calls.getSpendSeries[0].to)).toBeLessThanOrEqual(Date.now());
    });

    it("splits comma lists and rejects an unknown source", async () => {
        const { agg, calls } = fakeAggregator();
        const routes = aiRoutes(agg);

        await call(routes, "GET", "/api/ai/usage", { providers: "claude, grok", accounts: "acc_work" });
        expect(calls.getCurrentSnapshots[0]).toEqual({ providers: ["claude", "grok"], accounts: ["acc_work"] });

        const bad = await call(routes, "GET", "/api/ai/spend/totals", {
            from: "2026-09-04T11:00:00.000Z",
            to: "2026-09-04T12:00:00.000Z",
            source: "guesses",
        });
        expect(bad.status).toBe(400);
        expect(String(bad.body.error)).toContain("source");
    });

    it("GET usage never refreshes; POST refresh does, exactly once", async () => {
        const { agg, calls } = fakeAggregator();
        const routes = aiRoutes(agg);

        await call(routes, "GET", "/api/ai/usage");
        expect(calls.refreshSnapshots).toHaveLength(0);
        expect(calls.getCurrentSnapshots).toHaveLength(1);

        const refreshed = await call(routes, "POST", "/api/ai/usage/refresh");
        expect(refreshed.status).toBe(200);
        expect(calls.refreshSnapshots).toHaveLength(1);
    });

    it("GET daemon never registers; POST register does", async () => {
        const { agg, calls } = fakeAggregator();
        const routes = aiRoutes(agg);

        const status = await call(routes, "GET", "/api/ai/daemon");
        expect(status.body.registered).toBe(true);
        expect(calls.registerAiDaemon).toBe(0);

        const registered = await call(routes, "POST", "/api/ai/daemon/register");
        expect(registered.body).toEqual({ ok: true });
        expect(calls.registerAiDaemon).toBe(1);
    });
});

describe("claudeRoutes aliases", () => {
    it("GET /api/claude/usage equals GET /api/ai/usage?providers=anthropic-sub", async () => {
        const { agg } = fakeAggregator();
        const alias = await call(claudeRoutes(agg), "GET", "/api/claude/usage");
        const canonical = await call(aiRoutes(agg), "GET", "/api/ai/usage", { providers: "anthropic-sub" });

        expect(alias.status).toBe(200);
        expect(alias.body).toEqual(canonical.body);

        const snapshots = alias.body.snapshots as AccountUsageSnapshot[];
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].accountName).toBe("work");
        expect("native" in snapshots[0]).toBe(false);
    });

    it("the alias accepts a CLI alias too", async () => {
        const { agg } = fakeAggregator();
        const alias = await call(claudeRoutes(agg), "GET", "/api/claude/usage");
        const byAlias = await call(aiRoutes(agg), "GET", "/api/ai/usage", { providers: "claude" });

        expect(byAlias.body).toEqual(alias.body);
    });

    it("totals pins source=calls and a minutes window", async () => {
        const { agg, calls } = fakeAggregator();
        const { status, body } = await call(claudeRoutes(agg), "GET", "/api/claude/usage/totals", { minutes: "60" });

        expect(status).toBe(200);
        expect(body.source).toBe("calls");

        const query = calls.getSpendTotals[0];
        const spanMs = Date.parse(query.to) - Date.parse(query.from);
        expect(spanMs).toBeGreaterThanOrEqual(3_600_000);
        expect(spanMs).toBeLessThan(3_610_000);
    });

    it("history maps buckets to keys and pins the provider", async () => {
        const { agg, calls } = fakeAggregator();
        const { status } = await call(claudeRoutes(agg), "GET", "/api/claude/usage/history", {
            account: "work",
            buckets: "five_hour,seven_day",
            minutes: "1440",
        });

        expect(status).toBe(200);
        expect(calls.getUsageSeries[0]).toMatchObject({
            providers: ["anthropic-sub"],
            accounts: ["work"],
            keys: ["five_hour", "seven_day"],
        });
    });

    it("a bad minutes value falls back to the 1440 default instead of failing", async () => {
        const { agg, calls } = fakeAggregator();
        await call(claudeRoutes(agg), "GET", "/api/claude/usage/totals", { minutes: "nonsense" });

        const query = calls.getSpendTotals[0];
        const spanMs = Date.parse(query.to) - Date.parse(query.from);
        expect(spanMs).toBeGreaterThanOrEqual(86_400_000);
    });
});
