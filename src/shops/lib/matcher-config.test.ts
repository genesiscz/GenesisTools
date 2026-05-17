import { describe, expect, it } from "bun:test";
import { isLayer3GrayZone, MATCHER_CONFIG } from "@app/shops/lib/matcher-config";

describe("MATCHER_CONFIG", () => {
    it("L1 < L2A < L2B (stricter when more signal missing)", () => {
        expect(MATCHER_CONFIG.LAYER1_FUZZY_MIN).toBeLessThanOrEqual(MATCHER_CONFIG.LAYER2A_FUZZY_MIN);
        expect(MATCHER_CONFIG.LAYER2A_FUZZY_MIN).toBeLessThanOrEqual(MATCHER_CONFIG.LAYER2B_FUZZY_MIN);
    });

    it("L3 gray-zone band starts ≥ 0.92 and stops < autolink", () => {
        expect(MATCHER_CONFIG.LAYER3_GRAYZONE_MIN).toBeGreaterThanOrEqual(0.92);
        expect(MATCHER_CONFIG.LAYER3_GRAYZONE_MIN).toBeLessThan(MATCHER_CONFIG.LAYER3_AUTOLINK_MIN);
    });

    it("isLayer3GrayZone classifies edges", () => {
        expect(isLayer3GrayZone(0.91)).toBe(false);
        expect(isLayer3GrayZone(0.92)).toBe(true);
        expect(isLayer3GrayZone(0.94)).toBe(true);
        expect(isLayer3GrayZone(0.95)).toBe(false);
        expect(isLayer3GrayZone(0.96)).toBe(false);
    });
});
