import { describe, expect, it } from "bun:test";
import type { FillMonth, FillPlan, PlannedFillEntry, ReadyFillWeek } from "@app/clarity/lib/fill";
import type { FillResult, MonthFillInput, MonthFillPreview } from "@app/clarity/lib/month-fill";
import { fillTimesheetWeek, type TimesheetDeps, timesheetWeek } from "./index";

const Mapping = {
    clarityTaskId: 1,
    clarityTaskName: "Shop checkout",
    clarityTaskCode: "T-1",
    clarityInvestmentName: "Sample investment",
    clarityInvestmentCode: "P1",
    adoWorkItemId: 101,
    adoWorkItemTitle: "Fix the basket",
};

const Month: FillMonth = {
    month: 10,
    year: 2026,
    adoExport: {
        month: 10,
        year: 2026,
        fromDate: "2026-10-01",
        toDate: "2026-10-31",
        entries: [],
        summary: { totalMinutes: 0, totalHours: 0, entriesByProject: {}, entriesByWorkItem: {}, entriesByDay: {} },
    },
    fillMap: new Map(),
    unmappedByWi: new Map(),
    unmappedEntries: [],
    unmapped: { blocked: false, items: [], totalMinutes: 0 },
    dates: [],
};

function entry(minutes: number, action: PlannedFillEntry["action"] = "write"): PlannedFillEntry {
    return {
        fill: {
            mapping: Mapping,
            // A day outside the week stays out of the row.
            dayMinutes: { "2026-10-30": minutes, "2026-10-20": 60 },
            totalMinutes: minutes + 60,
            timelogEntries: [
                {
                    workItemId: 101,
                    workItemTitle: "Fix the basket",
                    workItemType: "Task",
                    timeTypeDescription: "Development",
                    comment: null,
                    date: "2026-10-30",
                    minutes,
                },
            ],
        },
        action,
        row: { timeEntryId: 9, taskId: 1, taskCode: "T-1" },
        replacedTaskIds: [],
        existingSegments: [{ start: "2026-10-29T00:00:00", finish: "2026-10-29T00:00:00", value: 1800 }],
        segments: [],
    };
}

function week(minutes: number, overrides: Partial<ReadyFillWeek> = {}): ReadyFillWeek {
    return {
        status: "ready",
        timesheetId: 77,
        periodStart: "2026-10-26T00:00:00",
        periodFinishInclusive: "2026-11-01T00:00:00",
        existingNotes: 0,
        entries: [entry(minutes), entry(0, "nothing-to-clear")],
        unmappedWorkItems: [{ workItemId: 202, minutes: 30 }],
        clarityRows: [],
        ...overrides,
    };
}

function plan(weeks: ReadyFillWeek[]): FillPlan {
    return { month: 10, year: 2026, fill: Month, weeks };
}

function deps(minutes: { value: number }, executed: MonthFillInput[]): TimesheetDeps {
    return {
        // The week starts in October, so a November day is found in the previous month's plan.
        preview: async ({ month }): Promise<MonthFillPreview> => ({
            plan: plan(month === 10 ? [week(minutes.value)] : []),
        }),
        execute: async (input): Promise<FillResult> => {
            executed.push(input);
            const written = week(minutes.value);
            return {
                plan: plan([written]),
                execution: { writes: new Map([[written.entries[0], { status: "success", totalSeconds: 60 }]]) },
            };
        },
    };
}

describe("the Friday timesheet", () => {
    it("chooses the next week on the preceding period's exclusive finish", async () => {
        const result = await timesheetWeek("2026-11-02", {
            preview: async () => ({
                plan: plan([
                    week(240),
                    week(120, {
                        timesheetId: 78,
                        periodStart: "2026-11-02T00:00:00",
                        periodFinishInclusive: "2026-11-08T00:00:00",
                    }),
                ]),
            }),
        });
        expect(result?.timesheetId).toBe(78);
    });

    it("renders the week of a day from the plan, even one that starts in the month before", async () => {
        const result = await timesheetWeek("2026-11-01", deps({ value: 240 }, []));

        expect(result).toMatchObject({
            timesheetId: 77,
            periodStart: "2026-10-26",
            periodFinish: "2026-11-02",
            totalMinutes: 240,
            unmapped: [{ workItemId: 202, minutes: 30 }],
        });
        // The entry with nothing to clear is not a row.
        expect(result?.rows).toEqual([
            {
                task: "Shop checkout",
                code: "T-1",
                minutesByDay: { "2026-10-30": 240 },
                totalMinutes: 240,
                clarityMinutes: 30,
                items: [{ workItemId: 101, title: "Fix the basket", minutes: 240 }],
            },
        ]);
    });

    it("fills the week it showed, and refuses one that changed since", async () => {
        const minutes = { value: 240 };
        const executed: MonthFillInput[] = [];
        const shown = await timesheetWeek("2026-10-30", deps(minutes, executed));
        const revision = shown?.revision ?? "";

        expect(
            await fillTimesheetWeek({ date: "2026-10-30", timesheetId: 77, revision }, deps(minutes, executed))
        ).toEqual({
            filled: true,
            written: 1,
            failed: 0,
            skipped: 1,
            error: null,
        });

        minutes.value = 300;
        const stale = await fillTimesheetWeek(
            { date: "2026-10-30", timesheetId: 77, revision },
            deps(minutes, executed)
        );

        expect(stale.filled).toBe(false);
        expect(stale.error).toContain("changed");
        expect(executed).toEqual([{ month: 10, year: 2026, weekIds: [77] }]);
    });

    it("a month the fill refuses is a receipt with the reason, not a throw", async () => {
        const minutes = { value: 240 };
        const shown = await timesheetWeek("2026-10-30", deps(minutes, []));
        const receipt = await fillTimesheetWeek(
            { date: "2026-10-30", timesheetId: 77, revision: shown?.revision ?? "" },
            {
                ...deps(minutes, []),
                execute: async () => ({
                    plan: plan([]),
                    refusal: { reason: "unresolved_dates", unresolvedDates: ["2026-10-30"] },
                }),
            }
        );

        expect(receipt).toMatchObject({ filled: false, written: 0 });
        expect(receipt.error).toContain("No Clarity period covers 2026-10-30");
    });
});
