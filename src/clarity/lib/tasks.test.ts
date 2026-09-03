import { describe, expect, test } from "bun:test";
import { listClarityTasks } from "@app/clarity/lib/tasks";
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
            },
            {
                taskId: 700043,
                taskName: "SampleTask_Incidents",
                taskCode: "00070705",
                investmentName: "Sample Project",
                investmentCode: "P100001",
                timeEntryId: 10311312,
            },
        ]);
    });
    test("rejects a timesheet id the server returns no record for", async () => {
        const api = { getTimesheet: async () => ({ timesheets: { _results: [] } }) as unknown as TimesheetResponse };

        await expect(listClarityTasks({ api, timesheetId: 555999 })).rejects.toThrow("Timesheet 555999 not found");
    });
});
