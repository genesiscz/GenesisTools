import { describe, expect, test } from "bun:test";
import { seekTargetFor } from "@ext/player-control";

describe("seekTargetFor", () => {
    test("a seek inside the video is taken as-is", () => {
        expect(seekTargetFor(0, 600)).toBe(0);
        expect(seekTargetFor(123, 600)).toBe(123);
    });

    test("a negative timestamp clamps to the start", () => {
        expect(seekTargetFor(-5, 600)).toBe(0);
    });

    test("a timestamp past the end clamps to the duration", () => {
        expect(seekTargetFor(900, 600)).toBe(600);
    });

    test("a live stream (Infinity duration) has no end to clamp against", () => {
        expect(seekTargetFor(900, Number.POSITIVE_INFINITY)).toBe(900);
    });

    test("a not-yet-loaded video (NaN duration) still seeks", () => {
        expect(seekTargetFor(900, Number.NaN)).toBe(900);
    });

    test("a non-finite timestamp is refused rather than assigned to currentTime", () => {
        expect(seekTargetFor(Number.NaN, 600)).toBeNull();
        expect(seekTargetFor(Number.POSITIVE_INFINITY, 600)).toBeNull();
    });
});
