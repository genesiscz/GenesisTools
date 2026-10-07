import { describe, expect, test } from "bun:test";
import { parseBuildRange, positiveInt } from "./helpers";

describe("positiveInt", () => {
    test("reads a whole number of 1 or more and nothing else", () => {
        expect(positiveInt("3")).toBe(3);
        expect(positiveInt(" 12 ")).toBe(12);

        for (const bad of ["0", "-1", "2oops", "1.5", "", "garbage", "99999999999999999999"]) {
            expect(positiveInt(bad)).toBeNull();
        }
    });
});

describe("parseBuildRange", () => {
    test("accepts two whole build numbers in order", () => {
        expect(parseBuildRange("12", "15", "stop-range")).toEqual({ from: 12, to: 15 });
        expect(parseBuildRange("7", "7", "stop-range")).toEqual({ from: 7, to: 7 });
    });

    test("refuses a partial, fractional, zero or unsafe number before any stop is sent", () => {
        for (const [from, to] of [
            ["12oops", "15"],
            ["12", "12.9"],
            ["0", "3"],
            ["-1", "3"],
            ["", "3"],
            ["1", "99999999999999999999"],
        ]) {
            expect(() => parseBuildRange(from ?? "", to ?? "", "stop-range")).toThrow("positive whole build numbers");
        }
    });

    test("refuses an inverted range instead of stopping nothing", () => {
        expect(() => parseBuildRange("20", "10", "stop-range")).toThrow("is after <to>");
    });
});
