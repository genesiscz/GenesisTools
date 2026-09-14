import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudEnv } from "./env";

/**
 * The session secret must fail closed. Booting production on the committed development literal
 * would let anyone holding this repo sign a session cookie for any user id, and it would do so
 * silently — which is why the negative control (production without the var throws) and the positive
 * control (development still boots) are both pinned here.
 */

const VARS = ["NODE_ENV", "DD_CLOUD_AUTH_SECRET"];

describe("getCloudEnv — auth secret", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of VARS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of VARS) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }
    });

    it("refuses to boot production without DD_CLOUD_AUTH_SECRET", () => {
        process.env.NODE_ENV = "production";
        expect(() => getCloudEnv()).toThrow(/DD_CLOUD_AUTH_SECRET/);
    });

    it("uses the configured secret in production", () => {
        process.env.NODE_ENV = "production";
        process.env.DD_CLOUD_AUTH_SECRET = "a-real-production-secret";
        expect(getCloudEnv().authSecret).toBe("a-real-production-secret");
    });

    it("still falls back outside production, so the app boots credential-less in dev and test", () => {
        process.env.NODE_ENV = "development";
        expect(getCloudEnv().authSecret).toMatch(/dev-only/);

        process.env.NODE_ENV = "test";
        expect(getCloudEnv().authSecret).toMatch(/dev-only/);
    });

    it("prefers an explicitly set secret outside production too", () => {
        process.env.NODE_ENV = "development";
        process.env.DD_CLOUD_AUTH_SECRET = "local-override";
        expect(getCloudEnv().authSecret).toBe("local-override");
    });
});
/**
 * The managed-subdomain Pro gate is skipped whenever billing is unconfigured. On a self-hosted
 * instance that is deliberate; in production it is usually a misconfiguration, and the two look
 * identical from the code. So production says it out loud — once, not per request — and the
 * negative control (dev stays quiet) is pinned beside it so the warning cannot leak into normal use.
 *
 * `billingWarned` is module state, so each case re-imports the module to get a fresh one.
 */
describe("isStripeConfigured — unconfigured billing in production", () => {
    const KEYS = ["NODE_ENV", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }

        vi.resetModules();
    });

    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }

        vi.restoreAllMocks();
    });

    it("says so once in production, and not again on the next call", async () => {
        process.env.NODE_ENV = "production";
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { isStripeConfigured } = await import("./env");

        expect(isStripeConfigured()).toBe(false);
        expect(isStripeConfigured()).toBe(false);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toMatch(/STRIPE_SECRET_KEY is unset in production/);
    });

    it("stays quiet when billing IS configured", async () => {
        process.env.NODE_ENV = "production";
        process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
        // getStripeEnv refuses a production key without its webhook secret, so "configured" is both.
        process.env.STRIPE_WEBHOOK_SECRET = "whsec_not_a_real_secret";
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { isStripeConfigured } = await import("./env");

        expect(isStripeConfigured()).toBe(true);
        expect(spy).not.toHaveBeenCalled();
    });

    it("stays quiet outside production, where a billing-less instance is the normal case", async () => {
        process.env.NODE_ENV = "development";
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { isStripeConfigured } = await import("./env");

        expect(isStripeConfigured()).toBe(false);
        expect(spy).not.toHaveBeenCalled();
    });
});
