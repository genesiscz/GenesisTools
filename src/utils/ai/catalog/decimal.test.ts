import { describe, expect, test } from "bun:test";
import { perTokenToPer1M } from "./decimal";

describe("perTokenToPer1M", () => {
    /**
     * The whole reason this function exists: `parseFloat(s) * 1_000_000` answers
     * `0.19999999999999998` here, and `toBe` compares doubles exactly, so this
     * assertion fails under the old implementation.
     */
    test("converts without double-rounding noise", () => {
        expect(perTokenToPer1M("0.0000002")).toBe(0.2);
        expect(perTokenToPer1M("0.000000021")).toBe(0.021);
        expect(perTokenToPer1M("0.0000025")).toBe(2.5);
        expect(perTokenToPer1M("0.00001")).toBe(10);
    });

    test("accepts exponent form on both sides of the decimal point", () => {
        expect(perTokenToPer1M("1e-7")).toBe(0.1);
        expect(perTokenToPer1M("2.5E-6")).toBe(2.5);
        expect(perTokenToPer1M("1e-12")).toBe(0.000001);
    });

    /** `String(0.0000002)` is `"2e-7"`, so a number argument takes the exponent path. */
    test("numbers convert the same way as their string spelling", () => {
        expect(perTokenToPer1M(0.0000002)).toBe(0.2);
        expect(perTokenToPer1M(perTokenToPer1M("0.0000002") as number)).toBe(200_000);
    });

    /** OpenRouter's five meta routes quote -1; a negative rate subtracts from totals. */
    test("negative sentinels are rejected, not scaled", () => {
        expect(perTokenToPer1M("-1")).toBeUndefined();
        expect(perTokenToPer1M(-1)).toBeUndefined();
        expect(perTokenToPer1M("-0.0000002")).toBeUndefined();
    });

    test("an explicit zero stays a priced zero", () => {
        expect(perTokenToPer1M("0")).toBe(0);
        expect(perTokenToPer1M(0)).toBe(0);
        expect(perTokenToPer1M("0.0")).toBe(0);
    });

    test("unparseable input is undefined", () => {
        expect(perTokenToPer1M("")).toBeUndefined();
        expect(perTokenToPer1M("   ")).toBeUndefined();
        expect(perTokenToPer1M("free")).toBeUndefined();
        expect(perTokenToPer1M("Infinity")).toBeUndefined();
        expect(perTokenToPer1M(Number.NaN)).toBeUndefined();
        expect(perTokenToPer1M(Number.POSITIVE_INFINITY)).toBeUndefined();
    });
});
