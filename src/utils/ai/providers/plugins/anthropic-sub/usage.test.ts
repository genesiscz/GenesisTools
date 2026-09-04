import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AccountEntry } from "../../../config/schema";

/**
 * The 429 unlock and the probe guard, asserted at the primitive that SPENDS the grant.
 *
 * The usage endpoint allows exactly five requests per access token, so a 429 is answered by
 * rotating the token and retrying — that rotation is a single-use OAuth refresh. It must
 * happen on a real poll and must NEVER happen on a diagnosis (`probe: true`).
 */

interface ResolveCall {
    name?: string;
    forceRefresh?: boolean;
    noRefresh?: boolean;
}

const resolveCalls: ResolveCall[] = [];
let tokenCounter = 0;

mock.module("@genesiscz/utils/claude/subscription-auth", () => ({
    resolveAccountToken: async (name: string, options?: { forceRefresh?: boolean; noRefresh?: boolean }) => {
        resolveCalls.push({
            name,
            ...(options?.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh }),
            ...(options?.noRefresh === undefined ? {} : { noRefresh: options.noRefresh }),
        });
        tokenCounter += 1;

        return { token: `token-${tokenCounter}`, account: { name }, refreshed: options?.forceRefresh === true };
    },
}));

mock.module("@genesiscz/utils/ai/providers/plugins/anthropic-sub/subscription", () => ({
    isAnchorDue: () => false,
    planAllowsClaudeCode: () => true,
    refreshSubscriptionProfile: async () => true,
    revalidateStalePlan: async () => "alive",
    SUBSCRIPTION_RECHECK_MS: 6 * 60 * 60 * 1000,
}));

let legacyAccounts: Array<{ name: string; provider: string; tokens: Record<string, unknown> }> = [];

mock.module("@genesiscz/utils/ai/AIConfig", () => ({
    AIConfig: {
        load: async () => ({
            getAccountsByProvider: () => legacyAccounts,
            updateAccount: async () => {},
        }),
    },
}));

const { pollAnthropicAccount, toLimitWindows } = await import("./usage");

const originalFetch = globalThis.fetch;

const USAGE_BODY = {
    five_hour: { utilization: 42, resets_at: "2026-09-04T20:00:00.000Z" },
    seven_day: { utilization: 11, resets_at: "2026-09-10T20:00:00.000Z" },
    seven_day_sonnet: { utilization: 7, resets_at: "2026-09-10T20:00:00.000Z" },
};

function entry(name: string): AccountEntry {
    return { id: `acc_${name}`, name, provider: "anthropic-sub", credentials: {} } as AccountEntry;
}

function useAccount(name: string): void {
    legacyAccounts = [{ name, provider: "anthropic-sub", tokens: { accessToken: "at", refreshToken: "rt" } }];
}

/** Answers 429 for the first `failures` calls, then the usage payload. */
function stubFetch(failures: number): { calls: () => number } {
    let calls = 0;

    // `Object.assign` rather than a cast: Bun's `fetch` carries a `preconnect` member, and
    // a bare arrow function is not assignable to it.
    globalThis.fetch = Object.assign(
        async () => {
            calls += 1;

            if (calls <= failures) {
                return new Response("rate limited", { status: 429 });
            }

            return Response.json(USAGE_BODY);
        },
        { preconnect: originalFetch.preconnect }
    );

    return { calls: () => calls };
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    resolveCalls.length = 0;
    legacyAccounts = [];
    tokenCounter = 0;
});

describe("anthropic-sub usage.poll", () => {
    it("maps the response into provider-neutral windows and keeps the raw payload", async () => {
        useAccount("work");
        stubFetch(0);

        const snapshot = await pollAnthropicAccount(entry("work"));

        expect(snapshot.provider).toBe("anthropic-sub");
        expect(snapshot.accountId).toBe("acc_work");
        expect(snapshot.limits.map((w) => w.key)).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
        expect(snapshot.limits[0]).toMatchObject({ kind: "session", percentUsed: 42, periodMs: 5 * 60 * 60 * 1000 });
        expect(snapshot.limits[1]?.kind).toBe("weekly");
        expect(snapshot.limits[2]).toMatchObject({ kind: "scoped", scopeModel: "Sonnet" });
        // The legacy `usage-shared` projection and the anthropic TUI presenter both read it.
        expect(snapshot.native).toEqual(USAGE_BODY);
    });

    // The negative control: the rotate-on-429 unlock is what makes a shared poll work at
    // all, so a real poll must still reach it.
    it("a 429 on a real poll rotates the token and retries", async () => {
        useAccount("personal");
        const fetches = stubFetch(1);

        const snapshot = await pollAnthropicAccount(entry("personal"), { probe: false });

        expect(fetches.calls()).toBe(2);
        expect(resolveCalls).toEqual([{ name: "personal" }, { name: "personal", forceRefresh: true }]);
        expect(snapshot.limits.length).toBe(3);
    });

    it("a probe never asks for a refresh, and a 429 is reported instead of unlocked", async () => {
        useAccount("shop");
        const fetches = stubFetch(1);

        await expect(pollAnthropicAccount(entry("shop"), { probe: true })).rejects.toThrow("429");

        expect(fetches.calls()).toBe(1);
        expect(resolveCalls).toEqual([{ name: "shop", noRefresh: true }]);
        expect(resolveCalls.some((call) => call.forceRefresh)).toBe(false);
    });

    it("an org-blocked account is not unlocked either", async () => {
        useAccount("side");
        const fetches = stubFetch(1);

        await expect(pollAnthropicAccount(entry("side"), { orgBlocked: new Set(["side"]) })).rejects.toThrow("429");

        expect(fetches.calls()).toBe(1);
        expect(resolveCalls).toEqual([{ name: "side" }]);
    });
});

describe("toLimitWindows", () => {
    it("turns the spend bucket into one credit window carrying money", () => {
        const windows = toLimitWindows({
            ...USAGE_BODY,
            spend: {
                used: { amount_minor: 1234, currency: "USD", exponent: 2 },
                limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
                percent: 24.68,
                severity: "normal",
                enabled: true,
                cap: null,
            },
        });

        const credit = windows.find((w) => w.key === "extra_usage");

        expect(credit).toMatchObject({
            kind: "credit",
            percentUsed: 24.68,
            money: { usedMinor: 1234, limitMinor: 5000, currency: "USD", exponent: 2 },
        });
    });

    it("never writes the API's own weekly_all or session kind names", () => {
        const kinds = toLimitWindows(USAGE_BODY).map((w) => w.kind);

        expect(kinds).not.toContain("weekly_all");
        expect(kinds).not.toContain("weekly_scoped");
    });
});
