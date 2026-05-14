import { describe, expect, it } from "bun:test";
import { checkDateRangeCoverage } from "./store";

const dateRangeMin = Date.UTC(2026, 1, 1) / 1000;
const dateRangeMax = Date.UTC(2026, 3, 1) / 1000;

describe("checkDateRangeCoverage", () => {
    it("returns null when the index has no recorded coverage", () => {
        expect(
            checkDateRangeCoverage({ dateRangeMin: null, dateRangeMax: null, from: new Date("2026-01-01") })
        ).toBeNull();
    });

    it("returns null when the requested window is fully inside coverage", () => {
        expect(
            checkDateRangeCoverage({
                dateRangeMin,
                dateRangeMax,
                from: new Date("2026-02-15"),
                to: new Date("2026-03-15"),
            })
        ).toBeNull();
    });

    it("returns an advisory when --from is before coverage starts", () => {
        const advisory = checkDateRangeCoverage({
            dateRangeMin,
            dateRangeMax,
            from: new Date("2026-01-01"),
            to: new Date("2026-03-01"),
        });

        expect(advisory).toContain("partially outside indexed coverage");
        expect(advisory).toContain("2026-02-01 -> 2026-04-01");
    });

    it("returns an advisory when --to is after coverage ends", () => {
        const advisory = checkDateRangeCoverage({
            dateRangeMin,
            dateRangeMax,
            from: new Date("2026-03-01"),
            to: new Date("2026-05-01"),
        });

        expect(advisory).toContain("partially outside indexed coverage");
    });

    it("does not warn when --to is end-of-day on the coverage-max day (day-floor compare)", () => {
        expect(
            checkDateRangeCoverage({
                dateRangeMin,
                dateRangeMax,
                from: new Date("2026-03-01"),
                to: new Date("2026-04-01T23:59:59Z"),
            })
        ).toBeNull();
    });
});
