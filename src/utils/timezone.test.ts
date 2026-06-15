import { describe, expect, it } from "bun:test";
import { epochFromWallClockInZone, resolveZone, zoneOffsetMinutes } from "./timezone";

describe("resolveZone", () => {
    it("maps US abbreviations to IANA zones", () => {
        expect(resolveZone("PST")).toBe("America/Los_Angeles");
        expect(resolveZone("EST")).toBe("America/New_York");
        expect(resolveZone("CET")).toBe("Europe/Prague");
    });

    it("maps city names case-insensitively", () => {
        expect(resolveZone("Prague")).toBe("Europe/Prague");
        expect(resolveZone("tokyo")).toBe("Asia/Tokyo");
        expect(resolveZone("New York")).toBe("America/New_York");
        expect(resolveZone("  London  ")).toBe("Europe/London");
    });

    it("accepts raw IANA names unchanged", () => {
        expect(resolveZone("Europe/Prague")).toBe("Europe/Prague");
        expect(resolveZone("America/New_York")).toBe("America/New_York");
        expect(resolveZone("UTC")).toBe("UTC");
    });

    it("throws on an unknown zone", () => {
        expect(() => resolveZone("Nowhere")).toThrow();
        expect(() => resolveZone("Not/AZone")).toThrow();
    });
});

describe("epochFromWallClockInZone", () => {
    it("interprets summer (DST) wall-clock in Prague as CEST (+2)", () => {
        // 2026-06-02 09:00 in Europe/Prague (CEST, +2) === 07:00Z
        const epoch = epochFromWallClockInZone(2026, 6, 2, 9, 0, "Europe/Prague");
        expect(new Date(epoch).toISOString()).toBe("2026-06-02T07:00:00.000Z");
    });

    it("interprets winter wall-clock in Prague as CET (+1)", () => {
        // 2026-01-15 09:00 in Europe/Prague (CET, +1) === 08:00Z
        const epoch = epochFromWallClockInZone(2026, 1, 15, 9, 0, "Europe/Prague");
        expect(new Date(epoch).toISOString()).toBe("2026-01-15T08:00:00.000Z");
    });
});

describe("zoneOffsetMinutes", () => {
    it("returns +120 for Prague in summer", () => {
        const epoch = Date.UTC(2026, 5, 2, 7, 0, 0); // 07:00Z = 09:00 CEST
        expect(zoneOffsetMinutes(epoch, "Europe/Prague")).toBe(120);
    });

    it("returns -240 for New York in summer (EDT)", () => {
        const epoch = Date.UTC(2026, 5, 2, 12, 0, 0);
        expect(zoneOffsetMinutes(epoch, "America/New_York")).toBe(-240);
    });
});
