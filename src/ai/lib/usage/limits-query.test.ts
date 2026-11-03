import { describe, expect, mock, test } from "bun:test";
import * as realConfigStore from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import * as realLegacyCache from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import * as realPoll from "@genesiscz/utils/ai/usage-poll/poll";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The limits verbs answer from configured, visible accounts only. The snapshots file keeps every account the last
 * poll saw, so `--cached` would otherwise report (and advise) an account hidden or removed since. Invented handles.
 */

const account = (name: string, enabled: boolean) => ({
    id: `acc_${name}`,
    name,
    provider: "anthropic-sub",
    enabled,
    billing: { mode: "subscription" },
});

mock.module("@genesiscz/utils/ai/config/AiConfigStore", () => ({
    ...realConfigStore,
    AiConfigStore: {
        ...realConfigStore.AiConfigStore,
        readOnly: async () => ({
            accounts: () => [
                account("work", true),
                account("hidden", false),
                account("home", true),
                { ...account("home", true), id: "open-home", provider: "openai-sub" },
                { ...account("work", true), id: "open-work", provider: "openai-sub" },
            ],
        }),
    },
}));

const snapshot = (name: string): AccountUsageSnapshot => ({
    provider: "anthropic-sub",
    accountId: `acc_${name}`,
    accountName: name,
    fetchedAt: "2026-11-03T08:00:00.000Z",
    limits: [{ key: "seven_day", label: "Weekly", kind: "weekly", percentUsed: 40 }],
});

mock.module("@genesiscz/utils/ai/usage-poll/legacy-cache", () => ({
    ...realLegacyCache,
    readSnapshotsCache: async () => ({
        fetchedAt: "2026-11-03T08:00:00.000Z",
        providers: {
            "anthropic-sub": {
                alias: "claude",
                displayName: "Claude",
                prominent: [],
                accounts: [snapshot("work"), snapshot("hidden"), snapshot("gone")],
            },
        },
    }),
}));

const requests: Array<{ providers?: string[]; accountFilter?: string[] }> = [];
mock.module("@genesiscz/utils/ai/usage-poll/poll", () => ({
    ...realPoll,
    pollAccounts: async (options: { providers?: string[]; accountFilter?: string[] }) => {
        requests.push(options);
        return [];
    },
}));

const { queryAdvice, queryLimitsNow } = await import("./limits-query");

describe("the limits verbs over the snapshots file", () => {
    test("polls selected provider/account pairs without cross-polling same-named accounts", async () => {
        requests.length = 0;
        await queryLimitsNow({ account: ["claude/work", "codex/home"], fresh: true });
        expect(requests.map(({ providers, accountFilter }) => [providers, accountFilter])).toEqual([
            [["anthropic-sub"], ["work"]],
            [["openai-sub"], ["home"]],
        ]);
    });

    test("limits and advise answer only the visible configured accounts", async () => {
        const limits = await queryLimitsNow({ cached: true, provider: ["anthropic-sub"] });
        const advice = await queryAdvice({ cached: true, provider: ["anthropic-sub"] }, () => undefined);

        expect(limits.data.accounts.map((entry) => entry.accountName)).toEqual(["work"]);
        expect(SafeJSON.stringify(advice.data)).not.toContain("hidden");
        expect(SafeJSON.stringify(advice.data)).not.toContain("gone");
    });

    test("advice from cached snapshots with no history says it has no forecast, never that a pick lasts", async () => {
        const advice = await queryAdvice({ cached: true, provider: ["anthropic-sub"] }, () => undefined);
        const picks = advice.data.providers.flatMap((provider) => provider.profiles.map((profile) => profile.pick));

        expect(picks.length).toBeGreaterThan(0);
        expect(picks.map((pick) => [pick?.accountName, pick?.forecast, pick?.lastsMinutes])).toEqual(
            picks.map(() => ["work", "unknown", null])
        );
    });
});
