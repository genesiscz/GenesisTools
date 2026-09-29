import { describe, expect, it, test } from "bun:test";
import {
    formatLocalDateTimeStamp,
    formatLocalFileTimestamp,
    formatLocalMonth,
    getDatesInMonth,
    getDaysInPeriodInclusive,
    getMonthDateRange,
    isDateInHalfOpenRange,
    parseDate,
    parseSince,
    parseUntil,
    startOfDay,
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

describe("isDateInHalfOpenRange", () => {
    // Reporting periods share a boundary date: one ends 2026-08-24 and the next starts on it.
    // The finish is therefore exclusive, so a boundary day belongs to exactly one period.
    test("includes the first day of the range", () => {
        expect(isDateInHalfOpenRange("2026-08-24", "2026-08-24", "2026-08-31")).toBe(true);
    });

    test("includes the day before the finish", () => {
        expect(isDateInHalfOpenRange("2026-08-30", "2026-08-24", "2026-08-31")).toBe(true);
    });

    test("excludes the finish day itself", () => {
        expect(isDateInHalfOpenRange("2026-08-31", "2026-08-24", "2026-08-31")).toBe(false);
    });

    test("excludes a day before the range", () => {
        expect(isDateInHalfOpenRange("2026-08-23", "2026-08-24", "2026-08-31")).toBe(false);
    });

    test("accepts ISO timestamps on either bound", () => {
        expect(isDateInHalfOpenRange("2026-08-26", "2026-08-24T00:00:00", "2026-08-31T00:00:00")).toBe(true);
    });
});

describe("getDaysInPeriodInclusive", () => {
    // Clarity's timesheet reports timePeriodFinish as the LAST day of the period, unlike the
    // carousel's exclusive finish_date. Dropping that day silently loses a whole day of hours.
    test("includes the finish day", () => {
        const days = getDaysInPeriodInclusive("2026-08-24T00:00:00", "2026-08-30T00:00:00");

        expect(days.map((d) => d.date)).toEqual([
            "2026-08-24",
            "2026-08-25",
            "2026-08-26",
            "2026-08-27",
            "2026-08-28",
            "2026-08-29",
            "2026-08-30",
        ]);
    });

    test("returns the single day of a one-day period", () => {
        const days = getDaysInPeriodInclusive("2026-08-31T00:00:00", "2026-08-31T00:00:00");

        expect(days.map((d) => d.date)).toEqual(["2026-08-31"]);
    });

    test("labels each day with its weekday and day of month", () => {
        const days = getDaysInPeriodInclusive("2026-08-31T00:00:00", "2026-08-31T00:00:00");

        expect(days[0].label).toBe("Mon 31");
    });
});

describe("startOfDay, parseSince and parseUntil", () => {
    const NOW = new Date("2026-03-02T15:00:00");
    const SINCE = new Date("2026-03-02T00:00:00");
    const at = (clock: string) => new Date(`2026-03-02T${clock}`).getTime();

    test("startOfDay is local midnight of the same day", () => {
        expect(startOfDay(NOW)).toEqual(SINCE);
    });

    test("parseSince reads midnight, a clock time and an ISO time", () => {
        expect(parseSince(undefined, NOW)?.getTime()).toBe(SINCE.getTime());
        expect(parseSince("9:30", NOW)?.getTime()).toBe(at("09:30:00"));
        expect(parseSince("2026-03-01T10:00:00.000Z", NOW)?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
        expect(parseSince("soon", NOW)).toBeNull();
    });

    test("parseSince refuses what Date.parse or setHours would silently misread", () => {
        // Date.parse reads "9" and "Sep 24" as dates in 2001; setHours rolls 25:99 into tomorrow.
        // new Date() rolls month 13 into next January and month 00 into last December with the same day,
        // and Date.parse rolls February 30 into March 2 when a time follows the date.
        for (const junk of [
            "9",
            "12",
            "Sep 24",
            "25:99",
            "12:60",
            "2026-13-45",
            "2026-02-30",
            "2026-13-01",
            "2026-00-15",
            "2026-02-30T10:00:00Z",
            "2026-13-01T10:00",
            "2026-04-31 10:00:00+00:00",
        ]) {
            expect(parseSince(junk, NOW)).toBeNull();
            expect(parseUntil(junk, NOW)).toBeNull();
        }

        expect(parseSince("23:59", NOW)?.getTime()).toBe(at("23:59:00"));
        // A bare date is local midnight, like the default, not UTC midnight.
        expect(parseSince("2026-03-01", NOW)?.getTime()).toBe(new Date("2026-03-01T00:00:00").getTime());
        expect(parseSince("2026-03-01T10:00:00+02:00", NOW)?.toISOString()).toBe("2026-03-01T08:00:00.000Z");
    });

    test("a year below 100 stays that year, not 19xx", () => {
        // Date.UTC and new Date(y, m, d) read years 0-99 as 1900-1999.
        expect(parseSince("0099-01-01T10:00:00Z", NOW)?.toISOString()).toBe("0099-01-01T10:00:00.000Z");
        expect(parseSince("0099-01-01", NOW)?.getFullYear()).toBe(99);
        expect(parseSince("0099-02-29", NOW)).toBeNull();
    });

    test("parseUntil is now by default and the end of a bare day", () => {
        expect(parseUntil(undefined, NOW)).toBe(NOW);
        expect(parseUntil("2026-03-01", NOW)?.getTime()).toBe(new Date("2026-03-02T00:00:00").getTime() - 1);
        expect(parseUntil("12:00", NOW)?.getTime()).toBe(at("12:00:00"));
        expect(parseUntil("later", NOW)).toBeNull();
    });
});
