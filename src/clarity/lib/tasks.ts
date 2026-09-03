import type { ClarityTask } from "@app/clarity/lib/types";
import type { TimeEntryRecord, TimesheetResponse } from "@genesiscz/utils/clarity";

export interface TimesheetReader {
    getTimesheet(timesheetId: number): Promise<TimesheetResponse>;
}

export async function listClarityTasks({
    api,
    timesheetId,
}: {
    api: TimesheetReader;
    timesheetId: number;
}): Promise<ClarityTask[]> {
    const data = await api.getTimesheet(timesheetId);
    const timesheet = data.timesheets._results[0];

    if (!timesheet) {
        throw new Error(`Timesheet ${timesheetId} not found`);
    }

    return (timesheet.timeentries?._results ?? []).map((entry: TimeEntryRecord) => ({
        taskId: entry.taskId,
        taskName: entry.taskName,
        taskCode: entry.taskCode,
        investmentName: entry.investmentName,
        investmentCode: entry.investmentCode,
        timeEntryId: entry._internalId,
    }));
}
