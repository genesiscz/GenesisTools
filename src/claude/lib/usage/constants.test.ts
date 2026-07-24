import { describe, expect, test } from "bun:test";
import { colorForPct, colorForPctWithReset, isResetImminent } from "./constants";

const NOW = new Date("2026-07-24T20:00:00.000Z");

function inMinutes(minutes: number): string {
    return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

describe("isResetImminent", () => {
    test("no reset scheduled is never imminent", () => {
        expect(isResetImminent("five_hour", null, NOW)).toBe(false);
    });

    test("a passed reset counts as imminent (cache lag)", () => {
        expect(isResetImminent("five_hour", inMinutes(-5), NOW)).toBe(true);
    });

    test("the 5h window uses a 30-minute horizon", () => {
        expect(isResetImminent("five_hour", inMinutes(20), NOW)).toBe(true);
        expect(isResetImminent("five_hour", inMinutes(45), NOW)).toBe(false);
    });

    test("weekly buckets use a 6-hour horizon", () => {
        expect(isResetImminent("seven_day", inMinutes(300), NOW)).toBe(true);
        expect(isResetImminent("seven_day", inMinutes(500), NOW)).toBe(false);
    });

    test("an unknown bucket falls back to the weekly horizon", () => {
        expect(isResetImminent("seven_day_fable", inMinutes(300), NOW)).toBe(true);
    });

    test("a malformed timestamp is not imminent", () => {
        expect(isResetImminent("five_hour", "not-a-date", NOW)).toBe(false);
    });
});

describe("colorForPctWithReset", () => {
    test("a spent bucket about to refill reads green, not red", () => {
        expect(colorForPct(95)).toBe("red");
        expect(colorForPctWithReset(95, "five_hour", inMinutes(10), NOW)).toBe("green");
    });

    test("a spent bucket with a distant reset stays red", () => {
        expect(colorForPctWithReset(95, "seven_day", inMinutes(2000), NOW)).toBe("red");
    });
});
