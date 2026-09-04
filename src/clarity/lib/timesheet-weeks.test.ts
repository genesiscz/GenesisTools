import { describe, expect, test } from "bun:test";
import {
    findPeriodForDate,
    findWeekForDate,
    parseTimesheetArg,
    selectWeeksForDateArg,
    type TimesheetWeek,
    taskSourceWeekOrder,
    weeksTouchingMonth,
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

    // selectWeeksForDateArg keeps them so a writer can report "Clarity has not opened this period
    // yet" instead of silently doing less than the month it was asked for. Narrowing is the
    // caller's job, and findWeekForDate still refuses them.
    test("are listed for a month that only they cover", () => {
        expect(selectWeeksForDateArg(WITH_FUTURE, "2026-09").map((w) => w.timePeriodId)).toEqual([400004]);
    });

    test("are not returned by findWeekForDate for a date inside them", () => {
        expect(findWeekForDate(WITH_FUTURE, "2026-09-03")).toBeUndefined();
    });

    test("are returned by findPeriodForDate for a date inside them", () => {
        expect(findPeriodForDate(WITH_FUTURE, "2026-09-03")?.timePeriodId).toBe(400004);
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

describe("weeksTouchingMonth", () => {
    test("keeps a period that only reaches into the month by one day", () => {
        expect(weeksTouchingMonth(WEEKS, 2026, 8).map((w) => w.timePeriodId)).toEqual([400001, 400002, 400003]);
    });

    // A period finishing on the first of a month ends the evening before it, because the finish
    // date is exclusive. Counting it would put the previous month's hours in this one.
    test("drops a period whose exclusive finish is the first day of the month", () => {
        expect(weeksTouchingMonth(WEEKS, 2026, 9)).toEqual([]);
    });

    test("handles a 31-day month's last day", () => {
        const week: TimesheetWeek = {
            timesheetId: 555009,
            timePeriodId: 400009,
            startDate: "2026-08-31",
            finishDate: "2026-09-07",
            totalHours: 0,
            status: "Open",
        };

        expect(weeksTouchingMonth([week], 2026, 8).map((w) => w.timePeriodId)).toEqual([400009]);
    });
});
