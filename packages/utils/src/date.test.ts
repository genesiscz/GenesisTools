import { describe, expect, it } from "bun:test";
import {
    formatLocalDateTimeStamp,
    formatLocalFileTimestamp,
    formatLocalMonth,
    getDatesInMonth,
    getMonthDateRange,
    parseDate,
} from "./date";

describe("parseDate", () => {
    it("parses valid date string", () => {
        const d = parseDate("2026-02-24");
        expect(d).toBeInstanceOf(Date);
        expect(d.getFullYear()).toBe(2026);
    });

    it("throws on invalid date string", () => {
        expect(() => parseDate("not-a-date")).toThrow("Invalid date: not-a-date");
    });

    it("throws on empty string", () => {
        expect(() => parseDate("")).toThrow("Invalid date:");
    });
});

describe("getMonthDateRange", () => {
    it("returns range for January", () => {
        expect(getMonthDateRange("2026-01")).toEqual({ since: "2026-01-01", upto: "2026-01-31" });
    });

    it("returns range for February (non-leap year)", () => {
        expect(getMonthDateRange("2025-02")).toEqual({ since: "2025-02-01", upto: "2025-02-28" });
    });

    it("returns range for February (leap year)", () => {
        expect(getMonthDateRange("2024-02")).toEqual({ since: "2024-02-01", upto: "2024-02-29" });
    });

    it("returns range for December", () => {
        expect(getMonthDateRange("2026-12")).toEqual({ since: "2026-12-01", upto: "2026-12-31" });
    });

    it("returns range for April (30 days)", () => {
        expect(getMonthDateRange("2026-04")).toEqual({ since: "2026-04-01", upto: "2026-04-30" });
    });
});

describe("getDatesInMonth", () => {
    it("returns correct count for January", () => {
        const dates = getDatesInMonth("2026-01");
        expect(dates.length).toBe(31);
        expect(dates[0]).toBe("2026-01-01");
        expect(dates[30]).toBe("2026-01-31");
    });

    it("returns 28 dates for Feb in non-leap year", () => {
        expect(getDatesInMonth("2025-02").length).toBe(28);
    });

    it("returns 29 dates for Feb in leap year", () => {
        expect(getDatesInMonth("2024-02").length).toBe(29);
    });

    it("all dates are in YYYY-MM-DD format", () => {
        for (const d of getDatesInMonth("2026-03")) {
            expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });
});

describe("local timestamp formatting", () => {
    const d = new Date(2026, 4, 14, 20, 49, 3, 120);

    it("formats display timestamps using local date/time fields", () => {
        expect(formatLocalDateTimeStamp(d)).toBe("2026-05-14 20:49:03");
        expect(formatLocalDateTimeStamp(d, { seconds: false })).toBe("2026-05-14 20:49");
    });

    it("formats filename-safe timestamps using local date/time fields", () => {
        expect(formatLocalFileTimestamp(d)).toBe("2026-05-14T20-49-03");
        expect(formatLocalFileTimestamp(d, { separator: "_", milliseconds: true })).toBe("2026-05-14_20-49-03-120");
    });

    it("formats local month", () => {
        expect(formatLocalMonth(d)).toBe("2026-05");
    });
});
