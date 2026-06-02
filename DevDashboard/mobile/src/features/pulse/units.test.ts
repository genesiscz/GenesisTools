import { describe, expect, it } from "bun:test";
import { DASH, formatClock, gb, pct, ratioPct } from "@/features/pulse/units";

describe("units formatters", () => {
    it("pct: one decimal with % suffix; null -> em dash", () => {
        expect(pct(12.34)).toBe("12.3%");
        expect(pct(0)).toBe("0.0%");
        expect(pct(null)).toBe(DASH);
    });

    it("ratioPct: rounded integer %; null/zero-total -> em dash", () => {
        expect(ratioPct(50, 200)).toBe("25%");
        expect(ratioPct(null, 200)).toBe(DASH);
        expect(ratioPct(50, 0)).toBe(DASH);
        expect(ratioPct(50, null)).toBe(DASH);
    });

    it("gb: bytes -> one-decimal GB; null -> em dash", () => {
        expect(gb(1024 ** 3 * 2)).toBe("2.0 GB");
        expect(gb(null)).toBe(DASH);
    });

    it("formatClock: ISO string -> HH:MM 24h; null/invalid -> em dash", () => {
        expect(formatClock("2026-05-29T08:05:00.000Z", "UTC")).toBe("08:05");
        expect(formatClock(null)).toBe(DASH);
        expect(formatClock("not-a-date")).toBe(DASH);
    });
});
