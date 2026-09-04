import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";

/**
 * The credential guard, asserted at the primitive that SPENDS the credential.
 *
 * `resolveAccountToken` rotates a single-use OAuth refresh token. Every suppression
 * rule in the poller exists so a known-dead or plan-blocked account never reaches it —
 * five lapsed accounts cost 5,160 guaranteed-failing requests on 2026-08-08. The spy
 * below both records and THROWS, so a path that reaches it fails loudly.
 */

const resolveCalls: string[] = [];
const profileCalls: string[] = [];
const revalidateCalls: string[] = [];
let usageFetches = 0;

mock.module("@genesiscz/utils/claude/subscription-auth", () => ({
    resolveAccountToken: async (name: string) => {
        resolveCalls.push(name);
        throw new Error(`resolveAccountToken(${name}) must not be reached for a suppressed account`);
    },
}));

mock.module("@genesiscz/utils/ai/providers/plugins/anthropic-sub/subscription", () => ({
    isAnchorDue: (account: { name: string }) => anchorDueFor.has(account.name),
    planAllowsClaudeCode: (entry: { subscriptionPlan?: string; planContradictedAt?: number }) =>
        Boolean(entry.planContradictedAt) || entry.subscriptionPlan !== "claude_free",
    refreshSubscriptionProfile: async (_config: unknown, account: { name: string }) => {
        profileCalls.push(account.name);
        return true;
    },
    revalidateStalePlan: async (_config: unknown, account: AIAccountEntry) => {
        revalidateCalls.push(account.name);

        if (!orgAliveFor.has(account.name)) {
            return "dead";
        }

        // Mirrors the real function: the stored reading is NOT erased, the
        // contradiction is recorded on the entry the caller still holds.
        account.planContradictedAt = 1;
        return "alive";
    },
    SUBSCRIPTION_RECHECK_MS: 6 * 60 * 60 * 1000,
}));

let accounts: AIAccountEntry[] = [];
const anchorDueFor = new Set<string>();
const orgAliveFor = new Set<string>();

mock.module("@genesiscz/utils/ai/AIConfig", () => ({
    AIConfig: {
        load: async () => ({
            getAccountsByProvider: () => accounts,
            updateAccount: async () => {},
        }),
    },
}));

const { fetchAllAccountsUsage } = await import("@genesiscz/utils/ai/providers/plugins/anthropic-sub/api");
const { blockedEntry, loadPollGate, recordFailure, savePollGate } = await import(
    "@genesiscz/utils/ai/usage-poll/poll-gate"
);

/** Every gate read and write in this file is the anthropic one, as `api.ts` does. */
const PROVIDER = "anthropic-sub";

const originalHome = env.get("GENESIS_TOOLS_HOME");
const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];

function account(name: string, extra: Partial<AIAccountEntry> = {}): AIAccountEntry {
    return {
        name,
        provider: "anthropic-sub",
        tokens: { accessToken: `at-${name}`, refreshToken: `rt-${name}` },
        ...extra,
    } as AIAccountEntry;
}

function useTempHome(): void {
    const home = mkdtempSync(join(tmpdir(), "usage-suppression-"));
    mkdirSync(home, { recursive: true });
    env.testing.set("GENESIS_TOOLS_HOME", home);
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    resolveCalls.length = 0;
    profileCalls.length = 0;
    revalidateCalls.length = 0;
    usageFetches = 0;
    accounts = [];
    anchorDueFor.clear();
    orgAliveFor.clear();
    globalThis.fetch = originalFetch;

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("poll suppression never spends a refresh token", () => {
    it("a gate-blocked account is not polled at all", async () => {
        useTempHome();
        accounts = [account("blocked")];

        const gate = recordFailure(recordFailure({}, "blocked", "boom", Date.now()), "blocked", "boom", Date.now());
        await savePollGate(PROVIDER, gate);
        expect(blockedEntry(gate, "blocked", Date.now())).not.toBeNull();

        const [usage] = await fetchAllAccountsUsage();

        expect(resolveCalls).toEqual([]);
        expect(usage.usage).toBeUndefined();
    });

    it("a plan-blocked account whose profile is not due is not polled", async () => {
        useTempHome();
        accounts = [account("free", { subscriptionPlan: "claude_free" } as Partial<AIAccountEntry>)];

        await fetchAllAccountsUsage();

        expect(resolveCalls).toEqual([]);
        expect(profileCalls).toEqual([]);
    });

    // The recovery path: a lapsed plan is ONLY ever noticed by the 6-hourly profile
    // re-read, so a due anchor must still be allowed through.
    it("a plan-blocked account whose profile IS due still reaches the token resolve", async () => {
        useTempHome();
        accounts = [account("renewed", { subscriptionPlan: "claude_free" } as Partial<AIAccountEntry>)];
        anchorDueFor.add("renewed");

        await fetchAllAccountsUsage();

        expect(resolveCalls).toEqual(["renewed"]);
    });

    // The negative control: an ordinary account must still be polled, or the guard
    // has quietly broken every account instead of protecting the dead ones.
    it("a healthy account still reaches the token resolve", async () => {
        useTempHome();
        accounts = [account("healthy")];

        await fetchAllAccountsUsage();

        expect(resolveCalls).toEqual(["healthy"]);
    });

    it("a gate-blocked dead-plan account reports the plan, not the gate reason", async () => {
        useTempHome();
        accounts = [
            account("shop", {
                subscriptionPlan: "claude_free",
                subscriptionStatus: "canceled",
            } as Partial<AIAccountEntry>),
        ];
        const now = Date.now();
        await savePollGate(
            PROVIDER,
            recordFailure(
                recordFailure({}, "shop", "Token expired (invalid_grant)", now),
                "shop",
                "Token expired (invalid_grant)",
                now
            )
        );

        const [usage] = await fetchAllAccountsUsage();

        expect(resolveCalls).toEqual([]);
        expect(usage.error).toContain("claude_free");
        expect(usage.error).not.toContain("invalid_grant");
    });

    // Observed on a live account, 2026-08-29: renewed hours earlier, still rendered "plan
    // expired". Its refresh grant was dead, so the profile re-read that would have
    // noticed the renewal could never run — the stale reading was self-sustaining.
    // The long-lived token proves the org is alive, which retires the reading and
    // lets the REAL blocker (re-login needed) surface instead.
    it("a dead-plan account whose org probe proves it alive reports the grant, not the plan", async () => {
        useTempHome();
        accounts = [
            account("revived", {
                subscriptionPlan: "claude_free",
                subscriptionStatus: "canceled",
            } as Partial<AIAccountEntry>),
        ];
        anchorDueFor.add("revived");
        orgAliveFor.add("revived");

        const now = Date.now();
        await savePollGate(
            PROVIDER,
            recordFailure(
                recordFailure({}, "revived", "Token expired (invalid_grant)", now),
                "revived",
                "Token expired (invalid_grant)",
                now
            )
        );

        const [usage] = await fetchAllAccountsUsage();

        expect(revalidateCalls).toEqual(["revived"]);
        expect(usage.error).toContain("invalid_grant");
        expect(usage.error).not.toContain("claude_free");
    });

    // The probe costs a network call, so it must not fire for accounts that have
    // no dead reading to retire.
    it("a healthy account is never org-probed", async () => {
        useTempHome();
        accounts = [account("healthy")];
        anchorDueFor.add("healthy");

        await fetchAllAccountsUsage();

        expect(revalidateCalls).toEqual([]);
    });

    it("a suppressed account does not record a failure in the gate", async () => {
        useTempHome();
        accounts = [account("free", { subscriptionPlan: "claude_free" } as Partial<AIAccountEntry>)];

        await fetchAllAccountsUsage();

        expect((await loadPollGate(PROVIDER)).free).toBeUndefined();
        expect(usageFetches).toBe(0);
    });
});
