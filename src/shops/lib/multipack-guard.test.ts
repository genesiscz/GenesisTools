import { describe, expect, it } from "bun:test";
import { compatPackCount } from "./multipack-guard";

describe("compatPackCount", () => {
    it("both null → compatible", () => {
        expect(compatPackCount(null, null)).toBe(true);
    });

    it("null vs 1 → compatible (single unspecified vs single explicit)", () => {
        expect(compatPackCount(null, 1)).toBe(true);
        expect(compatPackCount(1, null)).toBe(true);
    });

    it("null vs 6 → incompatible (unknown vs declared 6-pack)", () => {
        expect(compatPackCount(null, 6)).toBe(false);
        expect(compatPackCount(6, null)).toBe(false);
    });

    it("both non-null equal → compatible", () => {
        expect(compatPackCount(6, 6)).toBe(true);
    });

    it("both non-null different → incompatible", () => {
        expect(compatPackCount(6, 12)).toBe(false);
        expect(compatPackCount(1, 6)).toBe(false);
    });
});
