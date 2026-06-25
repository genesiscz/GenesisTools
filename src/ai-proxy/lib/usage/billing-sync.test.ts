import { describe, expect, it } from "bun:test";
import { snapshotFromUsage } from "@app/ai-proxy/lib/usage/billing-sync";

describe("billing snapshot shape", () => {
    it("stores grok usage under details.grok", () => {
        const snapshot = snapshotFromUsage(
            { name: "genesiscz", provider: "grok-subscription", providerSlug: "grok", enabled: true },
            {
                tier: "Premium",
                summary: "42% used",
                details: {
                    grok: {
                        billing: {
                            monthlyLimit: { val: 100 },
                            used: { val: 42 },
                            onDemandCap: { val: 0 },
                            billingPeriodStart: "2026-06-01",
                            billingPeriodEnd: "2026-07-01",
                        },
                        settings: { subscription_tier_display: "Premium" },
                    },
                },
            }
        );

        expect(snapshot?.grok?.billing?.used).toEqual({ val: 42 });
        expect(snapshot?.fetchedAt).toEqual(expect.any(String));
        expect("billing" in (snapshot ?? {})).toBe(false);
    });

    it("stores copilot usage under details.copilot", () => {
        const snapshot = snapshotFromUsage(
            {
                name: "genesiscz",
                provider: "github-copilot-subscription",
                providerSlug: "github-copilot",
                enabled: true,
            },
            {
                tier: "individual",
                summary: "Copilot chat quota: 10 remaining",
                details: {
                    copilot: { plan: "individual", quotaRemaining: 10 },
                },
            }
        );

        expect(snapshot?.copilot).toEqual({ plan: "individual", quotaRemaining: 10 });
        expect(snapshot?.fetchedAt).toEqual(expect.any(String));
    });
});
