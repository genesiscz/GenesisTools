import { describe, expect, test } from "bun:test";
import {
    DISPOSITIONS,
    getSrealityCategorySubCb,
    normalizeDisposition,
} from "@app/Internal/commands/reas/data/disposition-map";

describe("Disposition Map", () => {
    test("normalizes common Czech variants", () => {
        expect(normalizeDisposition("2+kk")).toBe("2+kk");
        expect(normalizeDisposition("2+KK")).toBe("2+kk");
        expect(normalizeDisposition("3+1")).toBe("3+1");
        expect(normalizeDisposition("garsoniera")).toBe("1+kk");
        expect(normalizeDisposition("garsoniéra")).toBe("1+kk");
        expect(normalizeDisposition("2 + KK")).toBe("2+kk");
        expect(normalizeDisposition("3 + 1")).toBe("3+1");
    });

    test("getSrealityCategorySubCb maps dispositions to Sreality codes", () => {
        expect(getSrealityCategorySubCb("1+kk")).toBe(2);
        expect(getSrealityCategorySubCb("2+kk")).toBe(4);
        expect(getSrealityCategorySubCb("3+1")).toBe(7);
    });

    test("DISPOSITIONS list has standard Czech dispositions", () => {
        expect(DISPOSITIONS).toContain("1+kk");
        expect(DISPOSITIONS).toContain("1+1");
        expect(DISPOSITIONS).toContain("2+kk");
        expect(DISPOSITIONS).toContain("5+1");
        expect(DISPOSITIONS.length).toBeGreaterThanOrEqual(10);
    });
});
