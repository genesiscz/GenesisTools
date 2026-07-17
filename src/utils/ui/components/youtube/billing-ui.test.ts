import { describe, expect, test } from "bun:test";
import { computeCreditBuckets, subscriptionRenewalCopy } from "@app/utils/ui/components/youtube/billing-ui";

const activeSub = {
    planId: "sub-monthly",
    status: "active" as const,
    periodEnd: "2026-07-31T00:00:00.000Z",
    allowance: 3000,
    allowanceRemaining: 2400,
    cancelAtPeriodEnd: false,
};

describe("computeCreditBuckets", () => {
    test("splits an active subscription balance into allowance + top-up", () => {
        // 2600 balance, 2400 of it is remaining allowance → 200 is top-up.
        expect(computeCreditBuckets({ credits: 2600, subscription: activeSub })).toEqual({
            total: 2600,
            allowanceRemaining: 2400,
            topup: 200,
            allowance: 3000,
        });
    });

    test("clamps allowanceRemaining to the balance when the ledger drifted low", () => {
        expect(computeCreditBuckets({ credits: 100, subscription: activeSub })).toEqual({
            total: 100,
            allowanceRemaining: 100,
            topup: 0,
            allowance: 3000,
        });
    });

    test("no subscription → everything is top-up", () => {
        expect(computeCreditBuckets({ credits: 500, subscription: null })).toEqual({
            total: 500,
            allowanceRemaining: 0,
            topup: 500,
            allowance: 0,
        });
    });

    test("canceled subscription contributes no allowance bucket", () => {
        const canceled = { ...activeSub, status: "canceled" as const };
        expect(computeCreditBuckets({ credits: 500, subscription: canceled })).toEqual({
            total: 500,
            allowanceRemaining: 0,
            topup: 500,
            allowance: 0,
        });
    });
});

describe("subscriptionRenewalCopy", () => {
    test("renews when not cancelling", () => {
        expect(subscriptionRenewalCopy(activeSub)).toBe("Renews Jul 31");
    });

    test("ends when cancelAtPeriodEnd", () => {
        expect(subscriptionRenewalCopy({ ...activeSub, cancelAtPeriodEnd: true })).toBe("Ends Jul 31 — won't renew");
    });

    test("null when no period end", () => {
        expect(subscriptionRenewalCopy({ ...activeSub, periodEnd: null })).toBeNull();
    });
});
