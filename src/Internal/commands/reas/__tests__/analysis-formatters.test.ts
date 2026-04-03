import { describe, expect, test } from "bun:test";
import {
    fmt,
    fmtCompactCurrency,
    fmtDays,
    fmtPercentile,
    pct,
} from "@app/Internal/commands/reas/ui/src/components/analysis/formatters";

describe("analysis formatters", () => {
    test("fmt uses Czech locale grouping", () => {
        expect(fmt(1234567)).toBe("1 234 567");
    });

    test("pct formats signed percentages when requested", () => {
        expect(pct(4.25)).toBe("4.3%");
        expect(pct(4.25, { signed: true })).toBe("+4.3%");
        expect(pct(-1.2, { signed: true })).toBe("-1.2%");
    });

    test("fmtCompactCurrency shortens large currency values", () => {
        expect(fmtCompactCurrency(1250000)).toBe("1.3M CZK");
        expect(fmtCompactCurrency(56000)).toBe("56k CZK");
    });

    test("fmtPercentile and fmtDays return readable labels", () => {
        expect(fmtPercentile(42)).toBe("42nd percentile");
        expect(fmtDays(18.4)).toBe("18 days");
    });
});
