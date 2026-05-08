import { describe, expect, it } from "bun:test";
import { parseCooldown, parsePercent } from "./watch";

describe("watch flag parsing", () => {
    it("parsePercent('15') = 0.15", () => {
        expect(parsePercent("15")).toBe(0.15);
    });

    it("parsePercent('0.2') = 0.2 (already a fraction)", () => {
        expect(parsePercent("0.2")).toBe(0.2);
    });

    it("parsePercent('15%') = 0.15", () => {
        expect(parsePercent("15%")).toBe(0.15);
    });

    it("parsePercent invalid throws", () => {
        expect(() => parsePercent("nope")).toThrow();
    });

    it("parseCooldown('24h') = 24", () => {
        expect(parseCooldown("24h")).toBe(24);
    });

    it("parseCooldown('48') = 48", () => {
        expect(parseCooldown("48")).toBe(48);
    });

    it("parseCooldown('2d') = 48", () => {
        expect(parseCooldown("2d")).toBe(48);
    });

    it("parseCooldown invalid throws", () => {
        expect(() => parseCooldown("forever")).toThrow();
    });
});
