import { describe, expect, test } from "bun:test";
import type { ClarityMapping } from "@app/clarity/config";
import { resolveFillWeeks } from "@app/clarity/lib/fill-weeks";
import type { ClarityApi } from "@genesiscz/utils/clarity";

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

// Mirrors the mappings this machine actually stores: a task link with no cached timesheet id.
const MAPPINGS_WITHOUT_TIMESHEET_ID = [
    {
        clarityTaskId: 700042,
        clarityTaskName: "SampleTask_Release_External_Capex",
        clarityTaskCode: "00070705",
        clarityInvestmentName: "Sample Project",
        clarityInvestmentCode: "P100001",
        adoWorkItemId: 111111,
        adoWorkItemTitle: "Sample work item",
        adoWorkItemType: "Task",
    },
] as ClarityMapping[];

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
    test("resolves dates to their timesheets when no mapping carries a cached timesheet id", async () => {
        const api = fakeApi();

        const result = await resolveFillWeeks({
            api: api as unknown as ClarityApi,
            mappings: MAPPINGS_WITHOUT_TIMESHEET_ID,
            dates: ["2026-08-04", "2026-08-26"],
            month: 8,
            year: 2026,
        });

        expect(result.weeks.map((w) => w.timesheetId)).toEqual([555001, 555004]);
    });

    test("returns one week per timesheet when several dates fall in the same period", async () => {
        const api = fakeApi();

        const result = await resolveFillWeeks({
            api: api as unknown as ClarityApi,
            mappings: MAPPINGS_WITHOUT_TIMESHEET_ID,
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
            api: api as unknown as ClarityApi,
            mappings: MAPPINGS_WITHOUT_TIMESHEET_ID,
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
            api: api as unknown as ClarityApi,
            mappings: MAPPINGS_WITHOUT_TIMESHEET_ID,
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
            api: api as unknown as ClarityApi,
            mappings: MAPPINGS_WITHOUT_TIMESHEET_ID,
            dates: ["2026-08-26"],
            month: 8,
            year: 2026,
        });

        expect(api.timesheetAppCalls[0]).toBeUndefined();
        expect(api.timesheetAppCalls.slice(1).every((id) => typeof id === "number")).toBe(true);
    });
});
