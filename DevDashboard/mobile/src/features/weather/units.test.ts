import { describe, expect, it } from "bun:test";
import { clock, DASH, temp } from "@/features/weather/units";

describe("weather units", () => {
    it("temp formats one decimal °C, em-dash on null", () => {
        expect(temp(18.42)).toBe("18.4°C");
        expect(temp(0)).toBe("0.0°C");
        expect(temp(null)).toBe(DASH);
    });

    it("clock formats 24h HH:MM, em-dash on null/invalid", () => {
        expect(clock("2026-05-30T05:41:00Z")).toMatch(/^\d{2}:\d{2}$/);
        expect(clock(null)).toBe(DASH);
        expect(clock("not-a-date")).toBe(DASH);
    });
});
