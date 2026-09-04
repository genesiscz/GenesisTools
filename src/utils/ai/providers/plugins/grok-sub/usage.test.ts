import { describe, expect, it } from "bun:test";
import type { AccountEntry } from "../../../config/schema";
import type { GrokBillingConfig, GrokSettings } from "../../../grok/types";
import type { GrokUsageClient } from "./usage";
import { pollGrokAccount, toCreditWindow } from "./usage";

/**
 * `noRefresh` is the guard at the line that spends the credential: the OIDC refresh rotates
 * a token inside a file the Grok CLI owns. Both halves are asserted here — a probe must
 * pass it, and a real poll must NOT, or every account dies at token expiry.
 */

const BILLING: GrokBillingConfig = {
    monthlyLimit: { val: 5000 },
    used: { val: 1250 },
    onDemandCap: { val: 0 },
    billingPeriodStart: "2026-09-01T00:00:00.000Z",
    billingPeriodEnd: "2026-10-01T00:00:00.000Z",
};

const SETTINGS: GrokSettings = { subscription_tier_display: "SuperGrok Heavy" };

function entry(name: string, credentials: AccountEntry["credentials"] = {}): AccountEntry {
    return { id: `acc_${name}`, name, provider: "grok-sub", credentials } as AccountEntry;
}

function client(): GrokUsageClient {
    return {
        async getBilling() {
            return BILLING;
        },
        async getSettings() {
            return SETTINGS;
        },
    };
}

interface ResolveCall {
    name?: string;
    authFile?: string;
    noRefresh?: boolean;
}

function recordingResolve(calls: ResolveCall[]) {
    return async (name?: string, options?: { authFile?: string; noRefresh?: boolean }) => {
        calls.push({
            ...(name === undefined ? {} : { name }),
            ...(options?.authFile === undefined ? {} : { authFile: options.authFile }),
            ...(options?.noRefresh === undefined ? {} : { noRefresh: options.noRefresh }),
        });

        return { token: "jwt", authPath: options?.authFile ?? "/tmp/.grok/auth.json", account: { name: name ?? "" } };
    };
}

describe("toCreditWindow", () => {
    it("builds one monthly credit window from used and monthlyLimit", () => {
        expect(toCreditWindow(BILLING)).toEqual({
            key: "monthly",
            label: "Monthly credit",
            kind: "credit",
            percentUsed: 25,
            resetsAt: "2026-10-01T00:00:00.000Z",
            money: { usedMinor: 1250, limitMinor: 5000, currency: "USD", exponent: 2 },
        });
    });

    it("reports 0% rather than dividing by a missing limit", () => {
        const window = toCreditWindow({ ...BILLING, monthlyLimit: { val: 0 } });

        expect(window.percentUsed).toBe(0);
        expect(window.money?.limitMinor).toBeUndefined();
    });
});

describe("grok-sub usage.poll", () => {
    it("returns the credit window and the plan name", async () => {
        const snapshot = await pollGrokAccount(
            entry("work", { authFile: "/tmp/.grok-work/auth.json" }),
            {},
            { resolveToken: recordingResolve([]), createClient: client }
        );

        expect(snapshot).toMatchObject({ provider: "grok-sub", accountId: "acc_work" });
        expect(snapshot.plan?.name).toBe("SuperGrok Heavy");
        expect(snapshot.limits.map((w) => w.key)).toEqual(["monthly"]);
    });

    it("a probe asks for noRefresh", async () => {
        const calls: ResolveCall[] = [];

        await pollGrokAccount(
            entry("personal", { authFile: "/tmp/.grok/auth.json" }),
            { probe: true },
            { resolveToken: recordingResolve(calls), createClient: client }
        );

        expect(calls).toEqual([{ name: "personal", authFile: "/tmp/.grok/auth.json", noRefresh: true }]);
    });

    // The negative control: a real poll must still be able to refresh, or the account
    // stops working the moment its token expires.
    it("a real poll does not ask for noRefresh", async () => {
        const calls: ResolveCall[] = [];

        await pollGrokAccount(
            entry("personal", { authFile: "/tmp/.grok/auth.json" }),
            { probe: false },
            { resolveToken: recordingResolve(calls), createClient: client }
        );

        expect(calls).toEqual([{ name: "personal", authFile: "/tmp/.grok/auth.json", noRefresh: false }]);
    });
});
