import { describe, expect, it } from "bun:test";
import type { AccountEntry } from "../../../config/schema";
import type { GrokCreditsConfig, GrokSettings } from "../../../grok/types";
import type { GrokUsageClient } from "./usage";
import { pollGrokAccount, toCreditWindow, toGrokLimits, toProductWindows, toSubscriptionWindow } from "./usage";

/**
 * `noRefresh` is the guard at the line that spends the credential: the OIDC refresh rotates
 * a token inside a file the Grok CLI owns. Both halves are asserted here — a probe must
 * pass it, and a real poll must NOT, or every account dies at token expiry.
 *
 * The figures below are invented. The SHAPE is the live one: whole percent over a rolling
 * seven-day period, split by product, with the money fields zero on a pure subscription.
 */

const PERIOD_START = "2099-03-01T00:00:00.000Z";
const PERIOD_END = "2099-03-08T00:00:00.000Z";

const CREDITS: GrokCreditsConfig = {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: PERIOD_START, end: PERIOD_END },
    creditUsagePercent: 42,
    productUsage: [
        { product: "GrokBuild", usagePercent: 30 },
        { product: "GrokChat", usagePercent: 12 },
    ],
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: PERIOD_START,
    billingPeriodEnd: PERIOD_END,
};

const SETTINGS: GrokSettings = { subscription_tier_display: "SuperGrok Heavy" };

function entry(name: string, credentials: AccountEntry["credentials"] = {}): AccountEntry {
    return { id: `acc_${name}`, name, provider: "grok-sub", credentials } as AccountEntry;
}

function client(): GrokUsageClient {
    return {
        async getCredits() {
            return CREDITS;
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

describe("toSubscriptionWindow", () => {
    it("reads the weekly allowance percent and the period end", () => {
        expect(toSubscriptionWindow(CREDITS)).toEqual({
            key: "weekly",
            label: "Weekly",
            kind: "weekly",
            percentUsed: 42,
            resetsAt: PERIOD_END,
        });
    });

    it("switches to a monthly window when xAI bills the period monthly", () => {
        const window = toSubscriptionWindow({
            ...CREDITS,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: PERIOD_START, end: PERIOD_END },
        });

        expect(window).toMatchObject({ key: "monthly", label: "Monthly", kind: "monthly" });
    });

    // An unknown period type must still draw a bar: a subscription bills weekly, so that is
    // the safer reading, and the debug log names the value nobody has seen before.
    it("falls back to weekly for an unrecognised period type", () => {
        const window = toSubscriptionWindow({ ...CREDITS, currentPeriod: { type: "USAGE_PERIOD_TYPE_LUNAR" } });

        expect(window).toMatchObject({ key: "weekly", kind: "weekly", percentUsed: 42 });
        expect(window.resetsAt).toBe(PERIOD_END);
    });

    it("reports 0% when the payload carries no percentage at all", () => {
        expect(toSubscriptionWindow({}).percentUsed).toBe(0);
    });
});

describe("toProductWindows", () => {
    it("names one scoped window per product, keyed lower-case", () => {
        expect(toProductWindows(CREDITS)).toEqual([
            { key: "product:grokbuild", label: "Grok Build", kind: "scoped", percentUsed: 30, resetsAt: PERIOD_END },
            { key: "product:grokchat", label: "Grok Chat", kind: "scoped", percentUsed: 12, resetsAt: PERIOD_END },
        ]);
    });

    it("returns nothing when the payload has no split", () => {
        expect(toProductWindows({ ...CREDITS, productUsage: undefined })).toEqual([]);
    });
});

describe("toCreditWindow", () => {
    // The negative control: a pure subscription reports zeros for every money field, and an
    // empty money bar beside a real percentage bar reads as "you have used nothing".
    it("omits the window entirely when there is no on-demand cap and no on-demand spend", () => {
        expect(toCreditWindow(CREDITS)).toBeUndefined();
    });

    it("builds a pay-as-you-go window from onDemandUsed against onDemandCap", () => {
        const window = toCreditWindow({ ...CREDITS, onDemandCap: { val: 5000 }, onDemandUsed: { val: 1250 } });

        expect(window).toEqual({
            key: "credit",
            label: "Pay-as-you-go",
            kind: "credit",
            percentUsed: 25,
            resetsAt: PERIOD_END,
            money: { usedMinor: 1250, limitMinor: 5000, currency: "USD", exponent: 2 },
        });
    });

    it("reports 0% rather than dividing by a missing cap", () => {
        const window = toCreditWindow({ ...CREDITS, onDemandCap: { val: 0 }, onDemandUsed: { val: 900 } });

        expect(window?.percentUsed).toBe(0);
        expect(window?.money?.limitMinor).toBeUndefined();
    });

    it("names a non-zero prepaid balance in the label", () => {
        const window = toCreditWindow({
            ...CREDITS,
            onDemandCap: { val: 5000 },
            onDemandUsed: { val: 1250 },
            prepaidBalance: { val: 2500 },
        });

        expect(window?.label).toBe("Pay-as-you-go (prepaid $25.00)");
    });
});

describe("toGrokLimits", () => {
    it("orders the allowance first, then the products, then the money", () => {
        const keys = toGrokLimits({ ...CREDITS, onDemandCap: { val: 5000 }, onDemandUsed: { val: 100 } }).map(
            (w) => w.key
        );

        expect(keys).toEqual(["weekly", "product:grokbuild", "product:grokchat", "credit"]);
    });

    it("drops the money window on a subscription with no on-demand spend", () => {
        expect(toGrokLimits(CREDITS).map((w) => w.key)).toEqual(["weekly", "product:grokbuild", "product:grokchat"]);
    });
});

describe("grok-sub usage.poll", () => {
    it("returns the subscription windows and the plan name", async () => {
        const snapshot = await pollGrokAccount(
            entry("work", { authFile: "/tmp/.grok-work/auth.json" }),
            {},
            { resolveToken: recordingResolve([]), createClient: client }
        );

        expect(snapshot).toMatchObject({ provider: "grok-sub", accountId: "acc_work" });
        expect(snapshot.plan?.name).toBe("SuperGrok Heavy");
        expect(snapshot.limits.map((w) => w.key)).toEqual(["weekly", "product:grokbuild", "product:grokchat"]);
        expect(snapshot.limits[0]).toMatchObject({ percentUsed: 42, resetsAt: PERIOD_END });
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
