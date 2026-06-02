import type { AccountUsage } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    claudeUsageKeys,
    HISTORY_INTERVAL_MS,
    USAGE_INTERVAL_MS,
    usageAccountsQuery,
    usageHistoryQuery,
} from "@/features/claude-usage/queries";

/**
 * Proves the claude-usage data layer flows through the D32 escape-hatch seam WITHOUT a React
 * renderer. Exercises the mock client's `get` escape hatch directly + the `queryOptions` factories'
 * queryFns against it (exactly what `useQuery` calls). Mirrors pulse/queries.test.ts.
 *
 * MOCK GAP, asserted (mock-client.ts is shared/read-only — flagged in notes, NOT edited):
 *  - `/api/claude/usage` → the mock returns `[MOCK_USAGE]` (a real AccountUsage[]).
 *  - `/api/claude/usage/history` is a PREFIX of `/api/claude/usage`, so the mock ALSO returns
 *    `[MOCK_USAGE]` for it — the wrong shape. The factory's `asHistory` guard coerces that to
 *    `{ series: [] }` so the chart renders empty instead of crashing. We assert that coercion here.
 */

describe("mock dashboard client — claude usage (escape hatch)", () => {
    it("get(/api/claude/usage) returns a believable account array", async () => {
        const accounts = await mockDashboardClient.get<AccountUsage[]>("/api/claude/usage");
        expect(Array.isArray(accounts)).toBe(true);
        expect(accounts[0].accountName.length).toBeGreaterThan(0);
    });
});

describe("claude-usage query factories", () => {
    it("usageAccountsQuery builds the accounts key + interval + a queryFn returning the array", async () => {
        const opts = usageAccountsQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...claudeUsageKeys.usage]);
        expect(opts.refetchInterval).toBe(USAGE_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");
        const data = await (opts.queryFn as unknown as () => Promise<AccountUsage[]>)();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });

    it("usageHistoryQuery encodes account + minutes into the key", () => {
        const opts = usageHistoryQuery(mockDashboardClient, "main", 1440);
        expect([...opts.queryKey]).toEqual(["claude-usage", "history", "main", 1440]);
        expect(opts.refetchInterval).toBe(HISTORY_INTERVAL_MS);
    });

    it("usageHistoryQuery's queryFn coerces the mock's wrong-shape payload to { series: [] }", async () => {
        // The mock's /history prefix-matches /api/claude/usage and returns an AccountUsage[], NOT a
        // MultiBucketHistoryResult — the `asHistory` guard must turn that into an empty result.
        const opts = usageHistoryQuery(mockDashboardClient, "main", 60);
        const data = await (opts.queryFn as unknown as () => Promise<{ series: unknown[] }>)();
        expect(Array.isArray(data.series)).toBe(true);
        expect(data.series).toHaveLength(0);
    });
});
