import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { TimeLogQueryEntry } from "@app/azure-devops/types";
import { type ClarityMapping, saveConfig, storage } from "@app/clarity/config";
import { buildAssignmentView } from "@app/clarity/lib/assignment-view";
import type { TimesheetWeekReader } from "@app/clarity/lib/timesheet-weeks";

// buildAssignmentView with every client injected as a fake: Clarity (carousel and catalogues),
// TimeLog (the month's hours) and the Azure DevOps work item reads (the ancestor chains). The config with the
// stored mappings is the sandboxed file. Every id is invented.

interface SyntheticPeriod {
    timePeriodId: number;
    start: string;
    finish: string;
    timesheetId: number;
}

interface CatalogueRow {
    taskId: number;
    taskName: string;
}

function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Monday weeks split at month boundaries, finish exclusive, as Clarity cuts its periods. */
function splitPeriods(from: string, to: string): SyntheticPeriod[] {
    const periods: SyntheticPeriod[] = [];
    let cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);

    while (cursor < end) {
        const nextMonday = new Date(cursor);
        nextMonday.setUTCDate(cursor.getUTCDate() + ((8 - cursor.getUTCDay()) % 7 || 7));
        const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
        const finish = nextMonday < nextMonth ? nextMonday : nextMonth;
        const index = periods.length;

        periods.push({
            timePeriodId: 6_100_000 + index,
            start: isoDay(cursor),
            finish: isoDay(finish),
            timesheetId: 7_100_000 + index,
        });
        cursor = finish;
    }

    return periods;
}

const Periods = splitPeriods("2026-06-01", "2027-01-04");
const CurrentIndex = Periods.findIndex((period) => period.start === "2026-11-02");

function ts(start: string): number {
    const id = Periods.find((period) => period.start === start)?.timesheetId;

    if (id === undefined) {
        throw new Error(`No synthetic period starts on ${start}`);
    }

    return id;
}

const Epic = { taskId: 700002, taskName: "D_410001_Sample epic_EXT" };
const Meetings = { taskId: 700003, taskName: "430001_Meetings_EXT" };
const Incidents = { taskId: 700004, taskName: "Incidents_Opex_EXT" };

/** A Clarity whose timesheets carry the given catalogues; a timesheet not listed has no rows. */
function fakeClarity(catalogues: Map<number, CatalogueRow[]>) {
    const timesheetCalls: number[] = [];

    const api: TimesheetWeekReader = {
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheetApp: async (timePeriodId?: number): Promise<any> => {
            const found = Periods.findIndex((period) => period.timePeriodId === timePeriodId);
            const centre = found >= 0 ? found : CurrentIndex;
            const current = Periods[centre];

            return {
                resource: { _results: [{ user_id: 900001 }] },
                timesheets: {
                    _results: [
                        { _internalId: current.timesheetId, numberOfEntries: 1, timePeriodId: current.timePeriodId },
                    ],
                },
                tscarousel: {
                    _results: Periods.slice(Math.max(0, centre - 4), centre + 5).map((period) => ({
                        id: period.timePeriodId,
                        is_active: period === Periods[CurrentIndex],
                        start_date: `${period.start}T00:00:00`,
                        finish_date: `${period.finish}T00:00:00`,
                        prstatus: { displayValue: "Otevřeno" },
                        tpTimesheet: {
                            _results: [
                                {
                                    timesheet_id: period.timesheetId,
                                    total: "0,00",
                                    prstatus: { _results: [{ displayValue: "Otevřeno" }] },
                                },
                            ],
                        },
                    })),
                },
            };
        },
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheet: async (timesheetId: number): Promise<any> => {
            timesheetCalls.push(timesheetId);
            const rows = catalogues.get(timesheetId) ?? [];

            return {
                timesheets: {
                    _results: [
                        {
                            _internalId: timesheetId,
                            numberOfEntries: rows.length,
                            // Clarity leaves the section out of a timesheet with no rows.
                            ...(rows.length > 0
                                ? {
                                      timeentries: {
                                          _results: rows.map((row, index) => ({
                                              _internalId: timesheetId * 10 + index,
                                              taskId: row.taskId,
                                              taskName: row.taskName,
                                              taskCode: `C-${row.taskId}`,
                                              investmentName: "Sample",
                                              investmentCode: "P100001",
                                              totalActuals: 0,
                                          })),
                                      },
                                  }
                                : {}),
                        },
                    ],
                },
            };
        },
    };

    return { api, timesheetCalls };
}

function adoEntry(workItemId: number, date: string, minutes: number): TimeLogQueryEntry {
    return {
        timeLogId: `log-${workItemId}-${date}`,
        comment: null,
        week: "2026-W32",
        timeTypeId: "tt-1",
        timeTypeDescription: "Development",
        minutes,
        date: `${date}T00:00:00`,
        userId: "user-1",
        userName: "Sample User",
        userEmail: null,
        projectId: "proj-1",
        workItemId,
        createdOn: `${date}T10:00:00`,
        createdBy: "user-1",
        updatedOn: null,
        updatedBy: null,
        deletedOn: null,
        deletedBy: null,
    };
}

function fakeTimeLog(entries: TimeLogQueryEntry[]) {
    const queries: unknown[] = [];
    const api = {
        user: { userId: "user-1", userName: "Sample User", userEmail: "sample@example.com" },
        queryTimeLogs: async (query: unknown) => {
            queries.push(query);
            return entries;
        },
    };

    return { api: api as unknown as TimeLogApi, queries };
}

const WorkItems = new Map<number, { title: string; type: string; parent?: number }>([
    [510001, { title: "Sample task", type: "Task", parent: 410001 }],
    [410001, { title: "Sample epic", type: "Epic" }],
    [510002, { title: "Weekly sync", type: "Task", parent: 430001 }],
    [430001, { title: "Meetings", type: "Task" }],
    [510003, { title: "Unmatched work", type: "Bug" }],
]);

function fakeWorkItems() {
    const calls: Array<{ ids: number[]; comments: unknown }> = [];
    const api = {
        getWorkItems: async (ids: number[], options: { comments?: boolean } = {}) => {
            calls.push({ ids: [...ids], comments: options.comments });

            return new Map(
                ids.flatMap((id) => {
                    const item = WorkItems.get(id);

                    return item
                        ? [
                              [
                                  id,
                                  {
                                      title: item.title,
                                      rawFields: { "System.WorkItemType": item.type },
                                      relations: item.parent
                                          ? [
                                                {
                                                    rel: "System.LinkTypes.Hierarchy-Reverse",
                                                    url: `https://dev.azure.com/sample/_apis/wit/workItems/${item.parent}`,
                                                },
                                            ]
                                          : [],
                                  },
                              ] as const,
                          ]
                        : [];
                })
            );
        },
    };

    return { api, calls };
}

interface Fakes {
    clarity: ReturnType<typeof fakeClarity>;
    timeLog: ReturnType<typeof fakeTimeLog>;
    workItems: ReturnType<typeof fakeWorkItems>;
}

// The one place these tests reach buildAssignmentView. A refactor of how it gets its clients
// changes this function and nothing below it.
async function view(date: string, fakes: Fakes) {
    return buildAssignmentView(date, {
        clarityApi: fakes.clarity.api,
        timeLogApi: fakes.timeLog.api,
        workItemApi: fakes.workItems.api,
    });
}

const AugustHours = [
    adoEntry(510001, "2026-08-04", 600),
    adoEntry(510002, "2026-08-11", 120),
    adoEntry(510003, "2026-08-20", 300),
];

function mapping(adoWorkItemId: number, task: CatalogueRow): ClarityMapping {
    return {
        clarityTaskId: task.taskId,
        clarityTaskName: task.taskName,
        clarityTaskCode: `C-${task.taskId}`,
        clarityInvestmentName: "Sample",
        clarityInvestmentCode: "P100001",
        adoWorkItemId,
        adoWorkItemTitle: "Weekly sync",
    };
}

beforeAll(() => {
    if (storage.getConfigPath().startsWith(`${homedir()}/.genesis-tools`)) {
        throw new Error(
            `Refusing to run: the test sandbox is not installed, config path is ${storage.getConfigPath()}`
        );
    }
});

afterEach(() => {
    const path = storage.getConfigPath();

    if (existsSync(path)) {
        unlinkSync(path);
    }
});

describe("buildAssignmentView", () => {
    test("splits the month's work items, recommends from the ancestor chain and flags a drifted mapping", async () => {
        await saveConfig({ baseUrl: "https://clarity.example.com", mappings: [mapping(510002, Incidents)] });
        const fakes = {
            clarity: fakeClarity(new Map([[ts("2026-08-10"), [Epic, Meetings, Incidents]]])),
            timeLog: fakeTimeLog(AugustHours),
            workItems: fakeWorkItems(),
        };

        const result = await view("2026-08", fakes);

        expect([result.month, result.year]).toEqual([8, 2026]);
        expect(result.tasks.map((task) => task.taskId)).toEqual([700002, 700003, 700004]);
        expect(
            result.assigned.map((row) => [row.workItemId, row.minutes, row.mapping?.clarityTaskId, row.drifted])
        ).toEqual([[510002, 120, 700004, true]]);
        expect(
            result.unassigned.map((row) => [row.workItemId, row.minutes, row.title, row.recommendation?.task.taskId])
        ).toEqual([
            [510001, 600, "Sample task", 700002],
            [510003, 300, "Unmatched work", undefined],
        ]);
        expect(result.assigned[0].recommendation?.task.taskId).toBe(700003);
        expect(result.chains.get(510001)?.map((node) => node.id)).toEqual([510001, 410001]);
        expect(fakes.timeLog.queries).toEqual([{ FromDate: "2026-08-01", ToDate: "2026-08-31", userId: "user-1" }]);
        expect(fakes.workItems.calls.every((call) => call.comments === false)).toBe(true);
        // Discovery reads every August week but the mid-month one, then the catalogue comes from it.
        expect(fakes.clarity.timesheetCalls).toEqual([
            ts("2026-08-01"),
            ts("2026-08-03"),
            ts("2026-08-17"),
            ts("2026-08-24"),
            ts("2026-08-31"),
            ts("2026-08-10"),
        ]);
    });

    test("a month whose own week has no rows takes the newest other week of the month that has them", async () => {
        await saveConfig({ baseUrl: "https://clarity.example.com", mappings: [] });
        const fakes = {
            clarity: fakeClarity(new Map([[ts("2026-08-24"), [Meetings]]])),
            timeLog: fakeTimeLog(AugustHours),
            workItems: fakeWorkItems(),
        };

        const result = await view("2026-08", fakes);

        expect(result.tasks.map((task) => task.taskId)).toEqual([700003]);
        expect(fakes.clarity.timesheetCalls.slice(5)).toEqual([ts("2026-08-10"), ts("2026-08-31"), ts("2026-08-24")]);
    });

    test("a month with no rows anywhere widens to the current window and takes its newest catalogue", async () => {
        await saveConfig({ baseUrl: "https://clarity.example.com", mappings: [] });
        const fakes = {
            clarity: fakeClarity(new Map([[ts("2026-11-16"), [Epic]]])),
            timeLog: fakeTimeLog(AugustHours),
            workItems: fakeWorkItems(),
        };

        const result = await view("2026-08", fakes);

        expect(result.tasks.map((task) => task.taskId)).toEqual([700002]);
        expect(result.unassigned.map((row) => row.recommendation?.task.taskId)).toEqual([700002, undefined, undefined]);
        // The month's six weeks, newest first after the mid-month one, then the current window's.
        expect(fakes.clarity.timesheetCalls.slice(5)).toEqual([
            ts("2026-08-10"),
            ts("2026-08-31"),
            ts("2026-08-24"),
            ts("2026-08-17"),
            ts("2026-08-03"),
            ts("2026-08-01"),
            ts("2026-10-12"),
            ts("2026-10-19"),
            ts("2026-10-26"),
            ts("2026-11-01"),
            ts("2026-11-09"),
            ts("2026-11-16"),
            ts("2026-11-23"),
            ts("2026-11-30"),
            ts("2026-11-30"),
            ts("2026-11-23"),
            ts("2026-11-16"),
        ]);
    });
});
