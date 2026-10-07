import { describe, expect, test } from "bun:test";
import {
    buildMonthAwareTimeSegments,
    fillMinutesInPeriod,
    replacementChangesActuals,
    requestedMonthActualSeconds,
} from "@app/clarity/lib/fill-utils";
import { resolveFillWeeks } from "@app/clarity/lib/fill-weeks";

function carouselEntry({
    id,
    start,
    finish,
    timesheetId,
}: {
    id: number;
    start: string;
    finish: string;
    timesheetId: number;
}) {
    return {
        id,
        resourceId: 900001,
        is_active: true,
        has_entries: "true",
        selected_id: 400004,
        start_date: `${start}T00:00:00`,
        finish_date: `${finish}T00:00:00`,
        tpTimesheet: {
            _results: [
                {
                    timesheet_id: timesheetId,
                    total: "0,00",
                    prmodtime: `${start}T09:00:00`,
                    prstatus: { _results: [{ displayValue: "Open", id: "0", _type: "lookup" }] },
                },
            ],
        },
    };
}

const CAROUSEL = [
    carouselEntry({ id: 400000, start: "2026-07-27", finish: "2026-08-03", timesheetId: 555000 }),
    carouselEntry({ id: 400001, start: "2026-08-03", finish: "2026-08-10", timesheetId: 555001 }),
    carouselEntry({ id: 400002, start: "2026-08-10", finish: "2026-08-17", timesheetId: 555002 }),
    carouselEntry({ id: 400003, start: "2026-08-17", finish: "2026-08-24", timesheetId: 555003 }),
    carouselEntry({ id: 400004, start: "2026-08-24", finish: "2026-08-31", timesheetId: 555004 }),
    carouselEntry({ id: 400005, start: "2026-08-31", finish: "2026-09-07", timesheetId: 555005 }),
];

function fakeApi() {
    const timesheetAppCalls: Array<number | undefined> = [];
    const openPeriods = new Set(CAROUSEL.map((entry) => entry.id));

    return {
        timesheetAppCalls,
        openPeriods,
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheetApp: async (timePeriodId?: number): Promise<any> => {
            timesheetAppCalls.push(timePeriodId);

            // A real carousel is a window CENTRED on the requested period, not the whole year.
            // Returning every period regardless of the argument lets a navigation bug pass.
            const centre = timePeriodId ?? 400004;

            return {
                resource: { _results: [{ user_id: 900001 }] },
                timesheets: { _results: [{ _internalId: 555004, numberOfEntries: 8, timePeriodId: centre }] },
                tscarousel: {
                    _results: CAROUSEL.filter((entry) => Math.abs(entry.id - centre) <= 2).map((entry) =>
                        openPeriods.has(entry.id) ? entry : { ...entry, tpTimesheet: { _results: [] } }
                    ),
                },
            };
        },
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheet: async (timesheetId: number): Promise<any> => ({
            timesheets: { _results: [{ _internalId: timesheetId, numberOfEntries: 8 }] },
        }),
    };
}

describe("resolveFillWeeks", () => {
    test("resolves each date to the timesheet whose period covers it", async () => {
        const api = fakeApi();

        const result = await resolveFillWeeks({
            api,
            dates: ["2026-08-04", "2026-08-26"],
            month: 8,
            year: 2026,
        });

        expect(result.weeks.map((w) => w.timesheetId)).toEqual([555001, 555004]);
    });

    test("returns one week per timesheet when several dates fall in the same period", async () => {
        const api = fakeApi();

        const result = await resolveFillWeeks({
            api,
            dates: ["2026-08-24", "2026-08-26", "2026-08-28"],
            month: 8,
            year: 2026,
        });

        expect(result.weeks.map((w) => w.timesheetId)).toEqual([555004]);
    });

    test("treats a period Clarity has not opened a timesheet for as an uncovered date", async () => {
        const api = fakeApi();
        // 2026-08-10..17 exists in the carousel but Clarity has not opened its timesheet, so it
        // has no id to write to; sending an absent id answers API-1006.
        api.openPeriods.delete(400002);

        const result = await resolveFillWeeks({
            api,
            dates: ["2026-08-12", "2026-08-26"],
            month: 8,
            year: 2026,
        });

        expect(result.unresolvedDates).toEqual(["2026-08-12"]);
        expect(result.weeks.map((w) => w.timesheetId)).toEqual([555004]);
    });

    test("reports dates that no period covers instead of dropping them silently", async () => {
        const api = fakeApi();

        const result = await resolveFillWeeks({
            api,
            dates: ["2026-08-26", "2026-12-24"],
            month: 8,
            year: 2026,
        });

        expect(result.unresolvedDates).toEqual(["2026-12-24"]);
    });
});

describe("resolveFillWeeks carousel use", () => {
    test("seeds without a filter, then navigates by period id", async () => {
        const api = fakeApi();

        await resolveFillWeeks({
            api,
            dates: ["2026-08-26"],
            month: 8,
            year: 2026,
        });

        expect(api.timesheetAppCalls[0]).toBeUndefined();
        expect(api.timesheetAppCalls.slice(1).every((id) => typeof id === "number")).toBe(true);
    });
});

describe("buildMonthAwareTimeSegments", () => {
    test("preserves adjacent-month actuals while replacing every requested-month day", () => {
        const segments = buildMonthAwareTimeSegments({
            periodStart: "2026-09-28T00:00:00",
            periodFinishExclusive: "2026-10-05T00:00:00",
            year: 2026,
            month: 10,
            dayMinutes: { "2026-10-01": 60 },
            existingSegments: [
                { start: "2026-09-30T00:00:00", finish: "2026-09-30T00:00:00", value: 7_200 },
                { start: "2026-10-02T00:00:00", finish: "2026-10-02T00:00:00", value: 1_800 },
            ],
        });

        expect(segments.map(({ start, value }) => [start.slice(0, 10), value])).toEqual([
            ["2026-09-28", 0],
            ["2026-09-29", 0],
            ["2026-09-30", 7_200],
            ["2026-10-01", 3_600],
            ["2026-10-02", 0],
            ["2026-10-03", 0],
            ["2026-10-04", 0],
        ]);
        expect(segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(10_800);
    });

    test("preserves the following month across a leap-year boundary", () => {
        const segments = buildMonthAwareTimeSegments({
            periodStart: "2028-02-28T00:00:00",
            periodFinishExclusive: "2028-03-06T00:00:00",
            year: 2028,
            month: 2,
            dayMinutes: { "2028-02-29": 30 },
            existingSegments: [{ start: "2028-03-01T00:00:00", finish: "2028-03-01T00:00:00", value: 900 }],
        });

        expect(segments.find((segment) => segment.start.startsWith("2028-02-29"))?.value).toBe(1_800);
        expect(segments.find((segment) => segment.start.startsWith("2028-03-01"))?.value).toBe(900);
    });
});

describe("fillMinutesInPeriod", () => {
    test("counts only fill minutes inside the period, so neighbour-month actuals never open a week", () => {
        const dayMinutes = { "2026-10-01": 60, "2026-10-12": 30 };

        expect(fillMinutesInPeriod(dayMinutes, "2026-09-28T00:00:00", "2026-10-05T00:00:00")).toBe(60);
        expect(fillMinutesInPeriod(dayMinutes, "2026-10-05T00:00:00", "2026-10-12T00:00:00")).toBe(0);
        expect(fillMinutesInPeriod(dayMinutes, "2026-10-12T00:00:00", "2026-10-19T00:00:00")).toBe(30);
    });
});

describe("zero-minute weeks", () => {
    const existing = [
        { start: "2026-09-30T00:00:00", finish: "2026-09-30T00:00:00", value: 7_200 },
        { start: "2026-10-02T00:00:00", finish: "2026-10-02T00:00:00", value: 1_800 },
    ];

    test("a week with requested-month actuals and no ADO minutes is a clearing write", () => {
        expect(requestedMonthActualSeconds(existing, { year: 2026, month: 10 })).toBe(1_800);
        const segments = buildMonthAwareTimeSegments({
            periodStart: "2026-09-28T00:00:00",
            periodFinishExclusive: "2026-10-05T00:00:00",
            year: 2026,
            month: 10,
            dayMinutes: {},
            existingSegments: existing,
        });

        expect(segments.find((segment) => segment.start.startsWith("2026-10-02"))?.value).toBe(0);
        expect(segments.find((segment) => segment.start.startsWith("2026-09-30"))?.value).toBe(7_200);
        expect(replacementChangesActuals(segments, existing)).toBe(true);
    });

    test("neighbour-month actuals alone never make a week worth writing", () => {
        const neighbourOnly = [existing[0]];
        expect(requestedMonthActualSeconds(neighbourOnly, { year: 2026, month: 10 })).toBe(0);
        const segments = buildMonthAwareTimeSegments({
            periodStart: "2026-09-28T00:00:00",
            periodFinishExclusive: "2026-10-05T00:00:00",
            year: 2026,
            month: 10,
            dayMinutes: {},
            existingSegments: neighbourOnly,
        });

        expect(replacementChangesActuals(segments, neighbourOnly)).toBe(false);
    });
});
