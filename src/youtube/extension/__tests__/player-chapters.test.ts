import { describe, expect, test } from "bun:test";
import { activeChapterIndex } from "@app/utils/ui/components/youtube/chapters";
import { tickPositionPct } from "@ext/player-chapters";

describe("tickPositionPct", () => {
    test("startSec 0 maps to 0%", () => {
        expect(tickPositionPct(0, 600)).toBe(0);
    });

    test("midpoint maps to 50%", () => {
        expect(tickPositionPct(300, 600)).toBe(50);
    });

    test("startSec beyond duration drops the tick", () => {
        expect(tickPositionPct(601, 600)).toBeNull();
    });

    test("negative startSec drops the tick", () => {
        expect(tickPositionPct(-1, 600)).toBeNull();
    });

    test("invalid duration drops the tick", () => {
        expect(tickPositionPct(10, 0)).toBeNull();
        expect(tickPositionPct(10, Number.NaN)).toBeNull();
    });
});

describe("activeChapterIndex", () => {
    const starts = [0, 120, 300];

    test("startSec <= t < next.startSec picks the containing chapter", () => {
        expect(activeChapterIndex(starts, 0)).toBe(0);
        expect(activeChapterIndex(starts, 119)).toBe(0);
        expect(activeChapterIndex(starts, 120)).toBe(1);
        expect(activeChapterIndex(starts, 299)).toBe(1);
    });

    test("last chapter is open-ended", () => {
        expect(activeChapterIndex(starts, 9999)).toBe(2);
    });

    test("before the first chapter and empty lists yield null", () => {
        expect(activeChapterIndex([60, 120], 10)).toBeNull();
        expect(activeChapterIndex([], 10)).toBeNull();
    });
});
