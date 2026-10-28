import { describe, expect, it } from "bun:test";
import type { AiProxyAccountConfig, AiProxyProviderType, UsageSummary } from "@app/ai-proxy/lib/types";
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

        expect(snapshot?.details).toEqual({
            grok: expect.objectContaining({ billing: expect.objectContaining({ used: { val: 42 } }) }),
        });
        expect("grok" in (snapshot ?? {})).toBe(false);
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

        expect(snapshot?.details).toEqual({ copilot: { plan: "individual", quotaRemaining: 10 } });
        expect("copilot" in (snapshot ?? {})).toBe(false);
        expect(snapshot?.fetchedAt).toEqual(expect.any(String));
    });

    it("keeps nothing for a provider whose usage is not stored, or for a read that lacks the provider's own details", () => {
        const account = (provider: AiProxyProviderType): AiProxyAccountConfig => ({
            name: "work",
            provider,
            providerSlug: "slug",
            enabled: true,
        });
        const copilotRead: UsageSummary = {
            accountName: "work",
            provider: "github-copilot-subscription",
            summary: "Copilot chat quota: 10 remaining",
            details: { copilot: { plan: "individual", quotaRemaining: 10 } },
        };
        const xaiRead: UsageSummary = {
            accountName: "work",
            provider: "xai-api-key",
            summary: "$1.00 spent",
            details: { xai: { teamUsage: { total: 1 }, prepaidBalance: { total: 5 } } },
        };

        expect([
            snapshotFromUsage(account("xai-api-key"), xaiRead),
            snapshotFromUsage(account("grok-subscription"), copilotRead),
            snapshotFromUsage(account("github-copilot-subscription"), xaiRead),
            snapshotFromUsage(account("anthropic-subscription"), { summary: "seat" }),
            snapshotFromUsage(account("openai-subscription"), copilotRead),
        ]).toEqual([null, null, null, null, null]);
    });
});
