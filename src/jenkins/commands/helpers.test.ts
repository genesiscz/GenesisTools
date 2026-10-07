import { describe, expect, test } from "bun:test";
import { parseBuildRange, positiveInt, resolveJobAndBuild } from "./helpers";

describe("resolveJobAndBuild", () => {
    const base = "https://ci.example.invalid/jenkins";

    test("drops the context path of a URL, so it is not prefixed a second time", () => {
        expect(resolveJobAndBuild({ jobOrUrl: `${base}/job/app/42/`, buildArg: undefined, baseUrl: base })).toEqual({
            jobPath: "job/app",
            buildNumber: "42",
        });
        expect(resolveJobAndBuild({ jobOrUrl: "job/app", buildArg: "7", baseUrl: base })).toEqual({
            jobPath: "job/app",
            buildNumber: "7",
        });
    });

    test("refuses a URL on another Jenkins", () => {
        expect(() =>
            resolveJobAndBuild({ jobOrUrl: "https://other.invalid/job/app/1/", buildArg: undefined, baseUrl: base })
        ).toThrow("not on the configured Jenkins");
    });
});

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
