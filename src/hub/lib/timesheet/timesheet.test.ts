import { describe, expect, it } from "bun:test";
import { fillTimesheetWeek, type TimesheetDeps, timesheetWeek } from "./index";

function week(minutes: number) {
    return {
        timesheetId: 77,
        periodStart: "2026-10-26",
        periodFinish: "2026-11-02",
        entries: [
            {
                clarityTaskName: "Shop checkout",
                clarityTaskCode: "T-1",
                dayValues: { "2026-10-30": minutes },
                totalMinutes: minutes,
                clarityCurrentMinutes: 0,
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
        ],
        unmappedWorkItems: [{ workItemId: 202, minutes: 30 }],
    };
}

function deps(minutes: { value: number }, executed: number[][]): TimesheetDeps {
    return {
        // The week starts in October, so a November day is found in the previous month's preview.
        preview: async (month) => ({
            weeks: month === 10 ? [week(minutes.value)] : [],
            totalMapped: 0,
            totalUnmapped: 0,
        }),
        execute: async (_month, _year, ids) => {
            executed.push(ids);
            return { success: 1, failed: 0, skipped: 0, entries: [] };
        },
    };
}

describe("the Friday timesheet", () => {
    it("chooses the next week on the preceding period's exclusive finish", async () => {
        const result = await timesheetWeek("2026-11-02", {
            preview: async () => ({
                weeks: [
                    week(240),
                    { ...week(120), timesheetId: 78, periodStart: "2026-11-02", periodFinish: "2026-11-09" },
                ],
                totalMapped: 0,
                totalUnmapped: 0,
            }),
        });
        expect(result?.timesheetId).toBe(78);
    });

    it("reads the week of a day, even one that starts in the month before", async () => {
        const result = await timesheetWeek("2026-11-01", deps({ value: 240 }, []));

        expect(result).toMatchObject({
            timesheetId: 77,
            totalMinutes: 240,
            unmapped: [{ workItemId: 202, minutes: 30 }],
        });
        expect(result?.rows[0]).toMatchObject({
            task: "Shop checkout",
            code: "T-1",
            items: [{ workItemId: 101, minutes: 240 }],
        });
    });

    it("fills the week it showed, and refuses one that changed since", async () => {
        const minutes = { value: 240 };
        const executed: number[][] = [];
        const shown = await timesheetWeek("2026-10-30", deps(minutes, executed));
        const revision = shown?.revision ?? "";

        expect(
            await fillTimesheetWeek({ date: "2026-10-30", timesheetId: 77, revision }, deps(minutes, executed))
        ).toEqual({
            filled: true,
            written: 1,
            failed: 0,
            skipped: 0,
            error: null,
        });

        minutes.value = 300;
        const stale = await fillTimesheetWeek(
            { date: "2026-10-30", timesheetId: 77, revision },
            deps(minutes, executed)
        );

        expect(stale.filled).toBe(false);
        expect(stale.error).toContain("changed");
        expect(executed).toEqual([[77]]);
    });
});
