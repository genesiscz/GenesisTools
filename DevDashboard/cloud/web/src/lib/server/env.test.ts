import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
