import type { AccountUsage } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import {
    claudeUsageKeys,
    HISTORY_INTERVAL_MS,
    USAGE_INTERVAL_MS,
    usageAccountsQuery,
    usageHistoryQuery,
    usageTotalsQuery,
} from "@/features/claude-usage/queries";

/**
 * Proves the claude-usage data layer through the real contract client over the fixture wire,
 * WITHOUT a React renderer: the `queryOptions` factories' queryFns (exactly what `useQuery` calls).
 * The fixture wire routes each path exactly, so `/api/claude/usage/history` gets its own
 * `MultiBucketHistoryResult` instead of the account array the old mock's prefix match returned.
 */

describe("fixture dashboard client — claude usage", () => {
    it("get(/api/claude/usage) returns a believable account array", async () => {
        const accounts = await fixtureDashboardClient.get<AccountUsage[]>("/api/claude/usage");
        expect(Array.isArray(accounts)).toBe(true);
        expect(accounts[0].accountName.length).toBeGreaterThan(0);
    });
});

describe("claude-usage query factories", () => {
    it("usageAccountsQuery builds the accounts key + interval + a queryFn returning the array", async () => {
        const opts = usageAccountsQuery(fixtureDashboardClient);
        expect([...opts.queryKey]).toEqual([...claudeUsageKeys.usage]);
        expect(opts.refetchInterval).toBe(USAGE_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");
        const data = await (opts.queryFn as unknown as () => Promise<AccountUsage[]>)();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });

    it("usageHistoryQuery encodes account + minutes into the key", () => {
        const opts = usageHistoryQuery(fixtureDashboardClient, "main", 1440);
        expect([...opts.queryKey]).toEqual(["claude-usage", "history", "main", 1440]);
        expect(opts.refetchInterval).toBe(HISTORY_INTERVAL_MS);
    });

    it("usageHistoryQuery's queryFn reads the history fixture, not the account array", async () => {
        const opts = usageHistoryQuery(fixtureDashboardClient, "main", 60);
        const data = await (opts.queryFn as unknown as () => Promise<{ series: unknown[] }>)();
        expect(Array.isArray(data.series)).toBe(true);
        expect(data.series).toHaveLength(0);
    });
});

describe("claude-usage queries — recorded spend totals", () => {
    it("reaches the totals fixture, not the account-usage one the prefix would have matched", async () => {
        const options = usageTotalsQuery(fixtureDashboardClient, 1440);
        const result = await options.queryFn!({} as never);

        expect(result.total.events).toBeGreaterThan(0);
        expect(result.accounts.length).toBeGreaterThan(0);
        expect(Object.keys(result.byApp).length).toBeGreaterThan(0);
    });

    it("keys the cache by window, so switching the range refetches", () => {
        expect(claudeUsageKeys.totals(60)).not.toEqual(claudeUsageKeys.totals(1440));
        // Spread both sides: `queryOptions` brands its queryKey with the dataTag symbols, so the
        // branded type and the plain key tuple are not comparable as-is.
        expect([...usageTotalsQuery(fixtureDashboardClient, 60).queryKey]).toEqual([...claudeUsageKeys.totals(60)]);
    });

    it("coerces a payload with no `total` to the empty shape instead of crashing the card", async () => {
        const stub = { get: async () => [{ accountName: "work" }] } as unknown as typeof fixtureDashboardClient;
        const result = await usageTotalsQuery(stub, 60).queryFn!({} as never);

        expect(result.total.events).toBe(0);
        expect(result.accounts).toEqual([]);
    });
});
