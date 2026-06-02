import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Guards the env-gating contract: with NO Stripe / Cloudflare creds, the modules must report
 * "not configured" and NEVER crash (the server must boot + the dashboard render credential-less,
 * e.g. under Playwright). This is the load-bearing safety property of Step 6.
 */

const STRIPE_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
const CF_VARS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"];

describe("env-gating: Stripe + Cloudflare are inert without creds", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of [...STRIPE_VARS, ...CF_VARS]) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of [...STRIPE_VARS, ...CF_VARS]) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }
    });

    it("Stripe reports unconfigured and getStripe() returns null", async () => {
        const { getStripe, isBillingConfigured, createCheckoutSession } = await import("./stripe");
        expect(isBillingConfigured()).toBe(false);
        expect(getStripe()).toBeNull();

        const checkout = await createCheckoutSession({
            tier: "pro",
            accountId: "a1",
            email: "x@y.z",
            appBaseUrl: "http://localhost:7251",
            existingCustomerId: null,
        });
        expect(checkout.configured).toBe(false);
        expect(checkout.url).toBeNull();
    });

    it("Cloudflare provisioning runs in demo mode (configured:false), never throws", async () => {
        const { provisionManagedSubdomain } = await import("@/lib/provision/cloudflare");
        const result = await provisionManagedSubdomain("martin");
        expect(result.configured).toBe(false);
        expect(result.hostname).toBe("martin.devdashboard.app");
        expect(result.vendorFronted).toBe(true);
        expect(result.note).toMatch(/not configured/i);
    });

    it("Cloudflare provisioning rejects an invalid subdomain name", async () => {
        const { provisionManagedSubdomain } = await import("@/lib/provision/cloudflare");
        await expect(provisionManagedSubdomain("A_B C!")).rejects.toThrow(/invalid subdomain/i);
    });
});
