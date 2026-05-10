import { describe, expect, it } from "bun:test";
import { parseCooldown, parsePercent } from "@app/shops/lib/watch-parsing";

describe("parsePercent", () => {
    it("'15' = 0.15", () => {
        expect(parsePercent("15")).toBe(0.15);
    });

    it("'0.2' = 0.2 (already a fraction)", () => {
        expect(parsePercent("0.2")).toBe(0.2);
    });

    it("'15%' = 0.15", () => {
        expect(parsePercent("15%")).toBe(0.15);
    });

    it("invalid throws", () => {
        expect(() => parsePercent("nope")).toThrow();
    });
});

describe("parseCooldown", () => {
    it("'24h' = 24", () => {
        expect(parseCooldown("24h")).toBe(24);
    });

    it("'48' = 48", () => {
        expect(parseCooldown("48")).toBe(48);
    });

    it("'2d' = 48", () => {
        expect(parseCooldown("2d")).toBe(48);
    });

    it("invalid throws", () => {
        expect(() => parseCooldown("forever")).toThrow();
    });
});
