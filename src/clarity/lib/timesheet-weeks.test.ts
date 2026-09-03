import { describe, expect, test } from "bun:test";
import {
    findWeekForDate,
    parseTimesheetArg,
    selectWeeksForDateArg,
    type TimesheetWeek,
    taskSourceWeekOrder,
} from "@app/clarity/lib/timesheet-weeks";

// Clarity carousel periods share a boundary date: one ends 2026-08-24 and the next starts
// 2026-08-24, while the timesheet itself reports 2026-08-24..2026-08-30. The finish date is
// therefore exclusive, and a boundary date belongs to the period that starts on it.
const WEEKS: TimesheetWeek[] = [
    {
        timesheetId: 555001,
        timePeriodId: 400001,
        startDate: "2026-08-17",
        finishDate: "2026-08-24",
        totalHours: 0,
        status: "Open",
    },
    {
        timesheetId: 555002,
        timePeriodId: 400002,
        startDate: "2026-08-24",
        finishDate: "2026-08-31",
        totalHours: 0,
        status: "Open",
    },
    {
        timesheetId: 555003,
        timePeriodId: 400003,
        startDate: "2026-08-31",
        finishDate: "2026-09-01",
        totalHours: 0,
        status: "Open",
    },
];

describe("findWeekForDate", () => {
    test("returns the period whose range covers a mid-week date", () => {
        expect(findWeekForDate(WEEKS, "2026-08-26")?.timesheetId).toBe(555002);
    });

    test("assigns a shared boundary date to the period that starts on it", () => {
        expect(findWeekForDate(WEEKS, "2026-08-24")?.timesheetId).toBe(555002);
    });

    test("assigns the day before the finish date to that period", () => {
        expect(findWeekForDate(WEEKS, "2026-08-30")?.timesheetId).toBe(555002);
    });

    test("returns undefined for a date no period covers", () => {
        expect(findWeekForDate(WEEKS, "2026-07-04")).toBeUndefined();
    });
});

describe("selectWeeksForDateArg", () => {
    test("returns only the covering period for a full date", () => {
        expect(selectWeeksForDateArg(WEEKS, "2026-08-26").map((w) => w.timesheetId)).toEqual([555002]);
    });

    test("returns every period that reaches into the month for a YYYY-MM argument", () => {
        expect(selectWeeksForDateArg(WEEKS, "2026-08").map((w) => w.timesheetId)).toEqual([555001, 555002, 555003]);
    });

    test("excludes a period that only touches the month through its exclusive finish date", () => {
        expect(selectWeeksForDateArg(WEEKS, "2026-09")).toEqual([]);
    });
});

describe("periods Clarity has not opened a timesheet for", () => {
    // The carousel lists future periods with no timesheet_id yet; selecting one sends
    // `timesheetId=undefined` to the API, which answers API-1006 invalidAttrValue.
    const WITH_FUTURE: TimesheetWeek[] = [
        ...WEEKS,
        {
            timesheetId: undefined as unknown as number,
            timePeriodId: 400004,
            startDate: "2026-09-01",
            finishDate: "2026-09-08",
            totalHours: 0,
            status: "Open",
        },
    ];

    test("are not returned for a month that only they cover", () => {
        expect(selectWeeksForDateArg(WITH_FUTURE, "2026-09")).toEqual([]);
    });

    test("are not returned for a date inside them", () => {
        expect(findWeekForDate(WITH_FUTURE, "2026-09-03")).toBeUndefined();
    });
});

describe("selectWeeksForDateArg input validation", () => {
    test("rejects an argument that is neither a day nor a month", () => {
        expect(() => selectWeeksForDateArg(WEEKS, "2026")).toThrow("expected YYYY-MM-DD or YYYY-MM");
    });
});

describe("taskSourceWeekOrder", () => {
    // A month's own timesheet can exist with no task rows yet, so the catalogue has to come from
    // whichever period actually has rows. Try the requested one first, then the newest others.
    test("puts the preferred week first", () => {
        expect(taskSourceWeekOrder(WEEKS, WEEKS[0]).map((w) => w.timesheetId)).toEqual([555001, 555003, 555002]);
    });

    test("orders the remaining weeks newest first", () => {
        expect(taskSourceWeekOrder(WEEKS, WEEKS[2]).map((w) => w.timesheetId)).toEqual([555003, 555002, 555001]);
    });

    test("returns every week newest first when there is no preference", () => {
        expect(taskSourceWeekOrder(WEEKS, undefined).map((w) => w.timesheetId)).toEqual([555003, 555002, 555001]);
    });
});

describe("parseTimesheetArg", () => {
    test("an absent flag is not supplied", () => {
        expect(parseTimesheetArg(undefined)).toEqual({ supplied: false });
    });

    test("a blank value counts as supplied so the caller cannot fall through to today's date", () => {
        expect(parseTimesheetArg("")).toEqual({ supplied: true });
        expect(parseTimesheetArg("   ")).toEqual({ supplied: true });
    });

    test("a non-numeric or non-positive value is supplied but has no id", () => {
        expect(parseTimesheetArg("abc")).toEqual({ supplied: true });
        expect(parseTimesheetArg("12abc")).toEqual({ supplied: true });
        expect(parseTimesheetArg("1.5")).toEqual({ supplied: true });
        expect(parseTimesheetArg("0")).toEqual({ supplied: true });
        expect(parseTimesheetArg("-3")).toEqual({ supplied: true });
    });

    test("a positive whole id parses", () => {
        expect(parseTimesheetArg("555004")).toEqual({ supplied: true, id: 555004 });
        expect(parseTimesheetArg(" 555004 ")).toEqual({ supplied: true, id: 555004 });
    });
});
