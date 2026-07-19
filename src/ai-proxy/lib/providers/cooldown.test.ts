import { beforeEach, describe, expect, it } from "bun:test";
import {
    cooldownRemainingMs,
    markRateLimited,
    markSuccess,
    markUnhealthy,
    resetCooldowns,
} from "@app/ai-proxy/lib/providers/cooldown";

describe("cooldown", () => {
    beforeEach(() => {
        resetCooldowns();
    });

    it("honours Retry-After and reports remaining time", () => {
        const applied = markRateLimited("acct", 60);

        expect(applied).toBe(60_000);
        expect(cooldownRemainingMs("acct")).toBeGreaterThan(55_000);
        expect(cooldownRemainingMs("other")).toBe(0);
    });

    it("backs off exponentially on consecutive strikes without Retry-After", () => {
        const first = markRateLimited("acct");
        const second = markRateLimited("acct");
        const third = markRateLimited("acct");

        expect(first).toBe(30_000);
        expect(second).toBe(60_000);
        expect(third).toBe(120_000);
    });

    it("resets on success", () => {
        markRateLimited("acct", 60);
        markSuccess("acct");

        expect(cooldownRemainingMs("acct")).toBe(0);
        expect(markRateLimited("acct")).toBe(30_000);
    });

    it("marks unhealthy accounts for a fixed window", () => {
        markUnhealthy("acct", 5_000);
        expect(cooldownRemainingMs("acct")).toBeGreaterThan(4_000);
    });
});
