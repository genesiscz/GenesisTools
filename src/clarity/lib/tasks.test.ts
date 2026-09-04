import { describe, expect, test } from "bun:test";
import { findTaskByName, listClarityTasks } from "@app/clarity/lib/tasks";
import type { TimesheetResponse } from "@genesiscz/utils/clarity";

function timesheetWithEntries(entries: Array<Record<string, unknown>>): TimesheetResponse {
    return {
        timesheets: {
            _results: [
                {
                    _internalId: 555001,
                    resourceId: 900001,
                    resourceName: "Sample Resource",
                    uniqueName: "sample.resource@example.com",
                    timePeriodId: 400001,
                    timePeriodStart: "2026-08-24T00:00:00",
                    timePeriodFinish: "2026-08-30T00:00:00",
                    timePeriodIsOpen: true,
                    status: { _results: [{ displayValue: "Open", id: "0" }] },
                    actualsTotal: 0,
                    numberOfEntries: entries.length,
                    timeentries: { _results: entries },
                },
            ],
        },
    } as unknown as TimesheetResponse;
}

function apiReturning(response: TimesheetResponse) {
    return {
        getTimesheet: async () => response,
    };
}

const SAMPLE_ENTRY = {
    _internalId: 10311311,
    resourceId: 900001,
    taskId: 700042,
    taskCode: "00070705",
    taskName: "SampleTask_Release_External_Capex",
    taskFullName: "FixedPart/SampleTask_Release_External_Capex",
    taskShortName: null,
    taskStartDate: "2026-01-01T00:00:00",
    taskFinishDate: "2026-12-31T00:00:00",
    phaseName: "FixedPart",
    phaseId: "1",
    parentTaskName: "FixedPart",
    parentTaskId: "2",
    investmentId: 300001,
    investmentName: "Sample Project",
    investmentCode: "P100001",
    totalActuals: 5400,
};

describe("listClarityTasks", () => {
    test("maps every time entry row to a task, taking timeEntryId from the row's internal id", async () => {
        const api = apiReturning(
            timesheetWithEntries([
                SAMPLE_ENTRY,
                { ...SAMPLE_ENTRY, _internalId: 10311312, taskId: 700043, taskName: "SampleTask_Incidents" },
            ])
        );

        const tasks = await listClarityTasks({ api, timesheetId: 555001 });

        expect(tasks).toEqual([
            {
                taskId: 700042,
                taskName: "SampleTask_Release_External_Capex",
                taskCode: "00070705",
                investmentName: "Sample Project",
                investmentCode: "P100001",
                timeEntryId: 10311311,
                totalActuals: 5400,
            },
            {
                taskId: 700043,
                taskName: "SampleTask_Incidents",
                taskCode: "00070705",
                investmentName: "Sample Project",
                investmentCode: "P100001",
                timeEntryId: 10311312,
                totalActuals: 5400,
            },
        ]);
    });
    // Passed through rather than defaulted: `totalActuals ?? 0` here would tell removeTaskRows that
    // a row it knows nothing about is empty, and it would delete booked hours.
    test("reports an absent totalActuals as undefined, not as zero", async () => {
        const { totalActuals: _dropped, ...withoutActuals } = SAMPLE_ENTRY;
        const api = apiReturning(timesheetWithEntries([withoutActuals]));

        const tasks = await listClarityTasks({ api, timesheetId: 555001 });

        expect(tasks[0].totalActuals).toBeUndefined();
    });

    test("rejects a timesheet id the server returns no record for", async () => {
        const api = { getTimesheet: async () => ({ timesheets: { _results: [] } }) as unknown as TimesheetResponse };

        await expect(listClarityTasks({ api, timesheetId: 555999 })).rejects.toThrow("Timesheet 555999 not found");
    });
});

describe("findTaskByName", () => {
    const CATALOGUE = [
        { taskName: "Incidenty_Opex_Sample_EXT" },
        { taskName: "Incidenty_Capex_Sample_EXT" },
        { taskName: "Rozvoj_domény_Sample_EXT" },
    ].map((t, i) => ({
        ...t,
        taskId: 700100 + i,
        taskCode: "00070705",
        investmentName: "Sample",
        investmentCode: "P100001",
        timeEntryId: i,
        totalActuals: 0,
    }));

    test("takes an exact name even when it is also a substring of another task", () => {
        const exact = { ...CATALOGUE[0], taskName: "Incidenty_Opex", taskId: 700200 };

        expect(findTaskByName([...CATALOGUE, exact], "Incidenty_Opex").task?.taskId).toBe(700200);
    });

    test("accepts a case-insensitive substring that matches exactly one task", () => {
        expect(findTaskByName(CATALOGUE, "rozvoj").task?.taskId).toBe(700102);
    });

    test("reports every candidate rather than picking one when a substring is ambiguous", () => {
        const result = findTaskByName(CATALOGUE, "Incidenty");

        expect(result.task).toBeUndefined();
        expect(result.ambiguous?.map((t) => t.taskId)).toEqual([700100, 700101]);
    });

    test("finds nothing for a name no task carries", () => {
        expect(findTaskByName(CATALOGUE, "Release")).toEqual({});
    });
});
