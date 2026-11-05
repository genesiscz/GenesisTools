import { describe, expect, test } from "bun:test";
import { loadTimesheetPeriods, type TimesheetWeek, type TimesheetWeekReader } from "@app/clarity/lib/timesheet-weeks";

// Clarity periods are Monday weeks SPLIT AT MONTH BOUNDARIES, so 1-, 2-, 3- and 4-day periods exist,
// and a period's finish date is EXCLUSIVE: the next period starts on it. Every id here is invented;
// the calendar is the real one for 2026.

interface SyntheticPeriod {
    timePeriodId: number;
    start: string;
    finish: string;
    timesheetId?: number;
    status: string;
}

const Unopened = new Set(["2026-11-23", "2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28"]);
/** Opened, but with no task rows yet: Clarity then leaves `timeentries` out of the timesheet. */
const NoRows = new Set(["2026-10-26"]);

function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function splitPeriods(from: string, to: string): SyntheticPeriod[] {
    const periods: SyntheticPeriod[] = [];
    let cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);

    while (cursor < end) {
        const nextMonday = new Date(cursor);
        nextMonday.setUTCDate(cursor.getUTCDate() + ((8 - cursor.getUTCDay()) % 7 || 7));
        const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
        const finish = nextMonday < nextMonth ? nextMonday : nextMonth;
        const start = isoDay(cursor);
        const index = periods.length;

        periods.push({
            timePeriodId: 6_000_000 + index,
            start,
            finish: isoDay(finish),
            timesheetId: Unopened.has(start) ? undefined : 7_000_000 + index,
            status: start < "2026-10-01" ? "Zaneseno" : "Otevřeno",
        });
        cursor = finish;
    }

    return periods;
}

const Periods = splitPeriods("2026-06-01", "2027-01-04");
const CurrentIndex = Periods.findIndex((period) => period.start === "2026-11-02");

function carouselEntry(period: SyntheticPeriod, active: boolean) {
    return {
        id: period.timePeriodId,
        is_active: active,
        start_date: `${period.start}T00:00:00`,
        finish_date: `${period.finish}T00:00:00`,
        prstatus: { displayValue: period.status },
        tpTimesheet: {
            _results:
                period.timesheetId === undefined
                    ? []
                    : [
                          {
                              timesheet_id: period.timesheetId,
                              total: "0,00",
                              prstatus: { _results: [{ displayValue: period.status }] },
                          },
                      ],
        },
    };
}

function inclusiveFinish(period: SyntheticPeriod): string {
    const last = new Date(`${period.finish}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);

    return `${isoDay(last)}T00:00:00`;
}

/** A carousel that answers a window of nine periods centred on the one asked for, as Clarity does. */
function fakeClarity() {
    const appCalls: Array<number | undefined> = [];
    const timesheetCalls: number[] = [];

    const api: TimesheetWeekReader = {
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheetApp: async (timePeriodId?: number): Promise<any> => {
            appCalls.push(timePeriodId);
            const found = Periods.findIndex((period) => period.timePeriodId === timePeriodId);
            const centre = found >= 0 ? found : CurrentIndex;
            const current = Periods[centre];

            return {
                resource: { _results: [{ user_id: 900001 }] },
                timesheets: {
                    _results:
                        current.timesheetId === undefined
                            ? []
                            : [
                                  {
                                      _internalId: current.timesheetId,
                                      numberOfEntries: 3,
                                      timePeriodId: current.timePeriodId,
                                  },
                              ],
                },
                tscarousel: {
                    _results: Periods.slice(Math.max(0, centre - 4), centre + 5).map((period) =>
                        carouselEntry(period, period === Periods[CurrentIndex])
                    ),
                },
            };
        },
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheet: async (timesheetId: number): Promise<any> => {
            timesheetCalls.push(timesheetId);
            const period = Periods.find((candidate) => candidate.timesheetId === timesheetId);

            return {
                timesheets: {
                    _results: period
                        ? [
                              {
                                  _internalId: timesheetId,
                                  numberOfEntries: NoRows.has(period.start) ? 0 : 2,
                                  timePeriodId: period.timePeriodId,
                                  timePeriodStart: `${period.start}T00:00:00`,
                                  timePeriodFinish: inclusiveFinish(period),
                                  ...(NoRows.has(period.start)
                                      ? {}
                                      : { timeentries: { _results: [{ taskId: 1 }, { taskId: 2 }] } }),
                              },
                          ]
                        : [],
                },
            };
        },
    };

    return { api, appCalls, timesheetCalls };
}

// The one place these tests reach the period code. A refactor of the module changes this function
// and nothing below it.
async function load(api: TimesheetWeekReader, scope: { month?: number; year?: number } = {}) {
    const periods = await loadTimesheetPeriods(api, scope);

    return {
        weeks: periods.weeks,
        records: periods.records,
        userId: periods.userId,
        covering: (date: string, options: { requireTimesheet?: boolean } = {}) => periods.covering(date, options),
        touchingMonth: (year: number, month: number) => periods.touchingMonth(year, month),
        forDateArg: (arg: string) => periods.forDateArg(arg),
        taskSourceOrder: (preferred: TimesheetWeek | undefined) => periods.taskSourceOrder(preferred),
        fillWeeks: async (dates: string[], options: { includeMonthWeeks?: boolean } = {}) =>
            periods.fillWeeks(dates, options),
    };
}

function label(week: TimesheetWeek | undefined): string | undefined {
    return (
        week &&
        `${week.startDate}..${week.finishDate} ${week.timesheetId === undefined ? "unopened" : "opened"} ${week.status}`
    );
}

/** The synthetic timesheet id of the period starting on a date. */
function ts(start: string): number {
    const id = Periods.find((period) => period.start === start)?.timesheetId;

    if (id === undefined) {
        throw new Error(`No opened synthetic period starts on ${start}`);
    }

    return id;
}

describe("timesheet periods: a month's periods", () => {
    test("August touches six periods: a 2-day start and a 1-day end", async () => {
        const periods = await load(fakeClarity().api, { month: 8, year: 2026 });

        expect(periods.weeks.map(label)).toEqual([
            "2026-08-01..2026-08-03 opened Zaneseno",
            "2026-08-03..2026-08-10 opened Zaneseno",
            "2026-08-10..2026-08-17 opened Zaneseno",
            "2026-08-17..2026-08-24 opened Zaneseno",
            "2026-08-24..2026-08-31 opened Zaneseno",
            "2026-08-31..2026-09-01 opened Zaneseno",
        ]);
        expect(periods.touchingMonth(2026, 8)).toEqual(periods.weeks);
        expect(periods.forDateArg("2026-08")).toEqual(periods.weeks);
        expect(periods.userId).toBe(900001);
    });

    test("September touches five periods, ending in a 3-day one", async () => {
        const periods = await load(fakeClarity().api, { month: 9, year: 2026 });

        expect(periods.weeks.map(label)).toEqual([
            "2026-09-01..2026-09-07 opened Zaneseno",
            "2026-09-07..2026-09-14 opened Zaneseno",
            "2026-09-14..2026-09-21 opened Zaneseno",
            "2026-09-21..2026-09-28 opened Zaneseno",
            "2026-09-28..2026-10-01 opened Zaneseno",
        ]);
    });

    test("November touches six periods: a 1-day Sunday, an unopened week and a 1-day Monday", async () => {
        const periods = await load(fakeClarity().api, { month: 11, year: 2026 });

        expect(periods.weeks.map(label)).toEqual([
            "2026-11-01..2026-11-02 opened Otevřeno",
            "2026-11-02..2026-11-09 opened Otevřeno",
            "2026-11-09..2026-11-16 opened Otevřeno",
            "2026-11-16..2026-11-23 opened Otevřeno",
            "2026-11-23..2026-11-30 unopened Otevřeno",
            "2026-11-30..2026-12-01 opened Otevřeno",
        ]);
    });

    test("a period ending on the 1st belongs to the month before, not to this one", async () => {
        const periods = await load(fakeClarity().api, { month: 10, year: 2026 });

        expect(periods.weeks.map(label)).toEqual([
            "2026-10-01..2026-10-05 opened Otevřeno",
            "2026-10-05..2026-10-12 opened Otevřeno",
            "2026-10-12..2026-10-19 opened Otevřeno",
            "2026-10-19..2026-10-26 opened Otevřeno",
            "2026-10-26..2026-11-01 opened Otevřeno",
        ]);
        expect(periods.touchingMonth(2026, 9)).toEqual([]);
    });

    test("a month a quarter back is reached through several carousel hops", async () => {
        const fake = fakeClarity();

        const periods = await load(fake.api, { month: 7, year: 2026 });

        expect(periods.weeks.map(label)).toEqual([
            "2026-07-01..2026-07-06 opened Zaneseno",
            "2026-07-06..2026-07-13 opened Zaneseno",
            "2026-07-13..2026-07-20 opened Zaneseno",
            "2026-07-20..2026-07-27 opened Zaneseno",
            "2026-07-27..2026-08-01 opened Zaneseno",
        ]);
        expect(
            fake.appCalls.map((id) => (id === undefined ? "seed" : Periods.find((p) => p.timePeriodId === id)?.start))
        ).toEqual(["seed", "2026-11-02", "2026-10-12", "2026-09-21", "2026-08-31", "2026-08-03", "2026-07-13"]);
        // The period the window is centred on takes its entry count from the app response, so its
        // timesheet is never read during discovery.
        expect([...periods.records.keys()].sort()).toEqual([
            ts("2026-07-01"),
            ts("2026-07-06"),
            ts("2026-07-20"),
            ts("2026-07-27"),
        ]);
    });

    test("without a month the current window of nine periods is returned", async () => {
        const periods = await load(fakeClarity().api);

        expect(periods.weeks).toHaveLength(9);
        expect(periods.weeks[0].startDate).toBe("2026-10-12");
        expect(periods.weeks[8].startDate).toBe("2026-11-30");
    });
});

describe("timesheet periods: the period covering a date", () => {
    test("short periods cover exactly their days, and a shared boundary belongs to the period starting there", async () => {
        const august = await load(fakeClarity().api, { month: 8, year: 2026 });
        const september = await load(fakeClarity().api, { month: 9, year: 2026 });
        const october = await load(fakeClarity().api, { month: 10, year: 2026 });
        const november = await load(fakeClarity().api, { month: 11, year: 2026 });

        expect(label(august.covering("2026-08-02"))).toBe("2026-08-01..2026-08-03 opened Zaneseno");
        expect(label(august.covering("2026-08-03"))).toBe("2026-08-03..2026-08-10 opened Zaneseno");
        expect(label(august.covering("2026-08-31"))).toBe("2026-08-31..2026-09-01 opened Zaneseno");
        expect(august.covering("2026-09-01")).toBeUndefined();
        expect(label(september.covering("2026-09-01"))).toBe("2026-09-01..2026-09-07 opened Zaneseno");
        expect(label(september.covering("2026-09-30"))).toBe("2026-09-28..2026-10-01 opened Zaneseno");
        expect(label(october.covering("2026-10-04"))).toBe("2026-10-01..2026-10-05 opened Otevřeno");
        expect(label(november.covering("2026-11-01"))).toBe("2026-11-01..2026-11-02 opened Otevřeno");
        expect(label(november.covering("2026-11-02"))).toBe("2026-11-02..2026-11-09 opened Otevřeno");
        expect(label(november.forDateArg("2026-11-01")[0])).toBe("2026-11-01..2026-11-02 opened Otevřeno");
    });

    test("a closed past period still resolves, with its read-only status", async () => {
        const periods = await load(fakeClarity().api, { month: 8, year: 2026 });

        expect(label(periods.covering("2026-08-12", { requireTimesheet: true }))).toBe(
            "2026-08-10..2026-08-17 opened Zaneseno"
        );
    });

    test("an unopened period covers its dates but offers no timesheet to write", async () => {
        const periods = await load(fakeClarity().api, { month: 11, year: 2026 });

        expect(label(periods.covering("2026-11-25"))).toBe("2026-11-23..2026-11-30 unopened Otevřeno");
        expect(periods.covering("2026-11-25", { requireTimesheet: true })).toBeUndefined();
        expect(periods.forDateArg("2026-11-25").map(label)).toEqual(["2026-11-23..2026-11-30 unopened Otevřeno"]);
        expect(periods.forDateArg("2026-12-20")).toEqual([]);
    });

    test("the task catalogue order tries the preferred period, then the newest opened ones", async () => {
        const periods = await load(fakeClarity().api, { month: 11, year: 2026 });

        expect(periods.taskSourceOrder(periods.covering("2026-11-10")).map((week) => week.timesheetId)).toEqual([
            ts("2026-11-09"),
            ts("2026-11-30"),
            ts("2026-11-16"),
            ts("2026-11-02"),
            ts("2026-11-01"),
        ]);
        expect(periods.taskSourceOrder(periods.covering("2026-11-25")).map((week) => week.timesheetId)).toEqual([
            ts("2026-11-30"),
            ts("2026-11-16"),
            ts("2026-11-09"),
            ts("2026-11-02"),
            ts("2026-11-01"),
        ]);
    });
});

describe("timesheet periods: a timesheet with no rows", () => {
    test("still covers its dates and counts zero entries", async () => {
        const periods = await load(fakeClarity().api, { month: 10, year: 2026 });

        const week = periods.covering("2026-10-28", { requireTimesheet: true });

        expect(label(week)).toBe("2026-10-26..2026-11-01 opened Otevřeno");
        expect(week?.entryCount).toBe(0);
        expect(periods.records.get(ts("2026-10-26"))?.timeentries).toBeUndefined();
        expect((await periods.fillWeeks(["2026-10-28"])).unresolvedDates).toEqual([]);
    });
});

describe("timesheet periods: fill weeks", () => {
    test("dates in an unopened period are unresolved", async () => {
        const periods = await load(fakeClarity().api, { month: 11, year: 2026 });

        const fill = await periods.fillWeeks(["2026-11-01", "2026-11-03", "2026-11-25", "2026-11-30"]);

        expect(fill.weeks.map(label)).toEqual([
            "2026-11-01..2026-11-02 opened Otevřeno",
            "2026-11-02..2026-11-09 opened Otevřeno",
            "2026-11-30..2026-12-01 opened Otevřeno",
        ]);
        expect(fill.unresolvedDates).toEqual(["2026-11-25"]);
        expect([...fill.clearingOnlyWeekIds]).toEqual([]);
    });

    test("with the month's weeks included, every other opened period of the month is clearing-only", async () => {
        const periods = await load(fakeClarity().api, { month: 8, year: 2026 });

        const fill = await periods.fillWeeks(["2026-08-04"], { includeMonthWeeks: true });

        expect(fill.weeks.map((week) => week.timesheetId)).toEqual([
            ts("2026-08-03"),
            ts("2026-08-01"),
            ts("2026-08-10"),
            ts("2026-08-17"),
            ts("2026-08-24"),
            ts("2026-08-31"),
        ]);
        expect(fill.unresolvedDates).toEqual([]);
        expect([...fill.clearingOnlyWeekIds]).toEqual([
            ts("2026-08-01"),
            ts("2026-08-10"),
            ts("2026-08-17"),
            ts("2026-08-24"),
            ts("2026-08-31"),
        ]);
    });

    test("an unopened period is never a clearing-only week", async () => {
        const periods = await load(fakeClarity().api, { month: 11, year: 2026 });

        const fill = await periods.fillWeeks(["2026-11-03"], { includeMonthWeeks: true });

        expect([...fill.clearingOnlyWeekIds]).toEqual([
            ts("2026-11-01"),
            ts("2026-11-09"),
            ts("2026-11-16"),
            ts("2026-11-30"),
        ]);
    });
});
