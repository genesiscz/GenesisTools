import { describe, expect, it } from "bun:test";
import { formatClock, parseClock } from "@app/youtube/lib/transcript-export";

describe("parseClock", () => {
    it("reads the three shapes formatClock writes", () => {
        expect(parseClock("42")).toBe(42);
        expect(parseClock("12:03")).toBe(723);
        expect(parseClock("1:02:03")).toBe(3723);
    });

    it("round-trips formatClock", () => {
        for (const seconds of [0, 59, 60, 723, 3599, 3723, 86_399]) {
            expect(parseClock(formatClock(seconds))).toBe(seconds);
        }
    });

    it("rejects components that are only partly numeric", () => {
        // `Number.parseInt` stops at the first non-digit, so these used to import as
        // 62 / 12 / 5 with fabricated segment timing rather than being skipped.
        expect(parseClock("1x:02")).toBeNull();
        expect(parseClock("12junk")).toBeNull();
        expect(parseClock("5.5")).toBeNull();
        expect(parseClock("-1:00")).toBeNull();
        expect(parseClock(" 12:03")).toBeNull();
    });

    it("rejects empty components and unsupported arity", () => {
        expect(parseClock("")).toBeNull();
        expect(parseClock(":30")).toBeNull();
        expect(parseClock("1:2:3:4")).toBeNull();
    });
});
