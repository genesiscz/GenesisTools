import { describe, expect, test } from "bun:test";
import { __testing, RateLimiter } from "./rate-limiter";

function makeLimiter(startMs = 0) {
    let clock = startMs;
    const slept: number[] = [];

    const limiter = new RateLimiter({
        now: () => clock,
        // Fixed draw keeps jitter deterministic; the distribution is instaloader's.
        random: () => 0.5,
        sleep: async (ms: number) => {
            slept.push(ms);
            clock += ms;
        },
    });

    return { limiter, slept, advance: (ms: number) => (clock += ms), clockNow: () => clock };
}

describe("RateLimiter budget", () => {
    test("allows requests up to the window cap without waiting", async () => {
        const { limiter, slept } = makeLimiter();

        for (let i = 0; i < __testing.MAX_PER_WINDOW; i++) {
            await limiter.acquire("test");
        }

        // Jitter sleeps are expected; budget sleeps are not.
        expect(limiter.used).toBe(__testing.MAX_PER_WINDOW);
        expect(slept.every((ms) => ms <= __testing.JITTER_MAX_MS)).toBe(true);
    });

    test("makes the caller wait once the window cap is reached", async () => {
        const { limiter } = makeLimiter();

        for (let i = 0; i < __testing.MAX_PER_WINDOW; i++) {
            await limiter.acquire("test");
        }

        // The whole point of a proactive budget: refuse BEFORE Instagram counts a
        // strike, rather than reacting to a 429 that has already been recorded.
        expect(limiter.waitTimeMs()).toBeGreaterThan(0);
    });

    test("frees capacity again once the window rolls past", async () => {
        const { limiter, advance } = makeLimiter();

        for (let i = 0; i < __testing.MAX_PER_WINDOW; i++) {
            await limiter.acquire("test");
        }

        expect(limiter.waitTimeMs()).toBeGreaterThan(0);
        advance(__testing.WINDOW_MS + 1);
        expect(limiter.waitTimeMs()).toBe(0);
        expect(limiter.used).toBe(0);
    });

    test("holds the cap against concurrent acquirers, not just sequential ones", async () => {
        // The check and the reservation are separated by two awaits. Unserialised,
        // every one of these reads the same free capacity before any of them
        // records a timestamp, so all 76 sail through a cap of 75 and none of them
        // ever sees a budget wait.
        const { limiter, slept } = makeLimiter();

        await Promise.all(Array.from({ length: __testing.MAX_PER_WINDOW + 1 }, () => limiter.acquire("concurrent")));

        // A sleep longer than the jitter ceiling can only be the budget wait, so
        // its presence proves the 76th caller was actually throttled.
        expect(slept.some((ms) => ms > __testing.JITTER_MAX_MS)).toBe(true);
    });

    test("caps jitter at instaloader's 15s ceiling", () => {
        let draw = 0.999999999;
        const limiter = new RateLimiter({ now: () => 0, random: () => draw });

        // An extreme draw would blow past the ceiling without the min().
        expect(limiter.jitterMs()).toBeLessThanOrEqual(__testing.JITTER_MAX_MS);

        draw = 0.5;
        expect(limiter.jitterMs()).toBeGreaterThan(0);
        expect(limiter.jitterMs()).toBeLessThanOrEqual(__testing.JITTER_MAX_MS);
    });
});
