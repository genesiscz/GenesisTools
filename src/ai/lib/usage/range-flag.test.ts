import { describe, expect, test } from "bun:test";
import { resolveRangeFlag } from "./range-flag";

describe("resolveRangeFlag", () => {
    test("an absent flag is not an error", () => {
        expect(resolveRangeFlag(undefined)).toEqual({ status: "unset" });
    });

    test("a known window parses to minutes", () => {
        expect(resolveRangeFlag("6h")).toEqual({ status: "ok", range: 360 });
        expect(resolveRangeFlag("60m")).toEqual({ status: "ok", range: 60 });
        expect(resolveRangeFlag("7d")).toEqual({ status: "ok", range: 10080 });
    });

    test("the flag passed with no value reports no `given`, so the help says a value is required", () => {
        expect(resolveRangeFlag(true)).toEqual({ status: "invalid" });
        expect(resolveRangeFlag("")).toEqual({ status: "invalid" });
        expect(resolveRangeFlag("   ")).toEqual({ status: "invalid" });
    });

    test("an unknown value is carried back so the help can quote it", () => {
        expect(resolveRangeFlag("bogus")).toEqual({ status: "invalid", given: "bogus" });
    });

    test("surrounding whitespace does not make a valid window unknown", () => {
        expect(resolveRangeFlag(" 24h ")).toEqual({ status: "ok", range: 1440 });
    });
});
