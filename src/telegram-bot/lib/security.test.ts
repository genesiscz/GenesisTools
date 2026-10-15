import { describe, expect, it } from "bun:test";
import { createRateLimiter } from "./security";

describe("createRateLimiter", () => {
    it("holds a command with a cooldown back until the cooldown has passed", () => {
        let now = 1_000_000;
        const limiter = createRateLimiter(() => now);

        expect(limiter.check("tools")).toEqual({ allowed: true });

        now += 2_000;
        expect(limiter.check("tools")).toEqual({ allowed: false, retryAfterMs: 3_000 });

        now += 3_000;
        expect(limiter.check("tools")).toEqual({ allowed: true });
    });

    it("keeps a separate cooldown for each command", () => {
        const limiter = createRateLimiter(() => 1_000_000);

        expect(limiter.check("tools").allowed).toBe(true);
        expect(limiter.check("run").allowed).toBe(true);
        expect(limiter.check("run").allowed).toBe(false);
    });

    it("never holds back a command that has no cooldown, however often it repeats", () => {
        const limiter = createRateLimiter(() => 1_000_000);

        expect(limiter.check("help").allowed).toBe(true);
        expect(limiter.check("help").allowed).toBe(true);
        expect(limiter.check("constructor").allowed).toBe(true);
        expect(limiter.check("constructor").allowed).toBe(true);
    });

    it("refuses the 21st command inside a minute and accepts one once the oldest has aged out", () => {
        let now = 1_000_000;
        const limiter = createRateLimiter(() => now);

        for (let i = 0; i < 20; i++) {
            expect(limiter.check(`unknown${i}`).allowed).toBe(true);
        }

        expect(limiter.check("unknown20")).toEqual({ allowed: false, retryAfterMs: 60_000 });

        now += 60_000;
        expect(limiter.check("unknown21").allowed).toBe(true);
    });
});
