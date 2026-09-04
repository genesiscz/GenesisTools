import type { ClarityTask } from "@app/clarity/lib/types";
import type { TimeEntryRecord, TimesheetResponse } from "@genesiscz/utils/clarity";

export interface TimesheetReader {
    getTimesheet(timesheetId: number): Promise<TimesheetResponse>;
}

export interface TaskNameLookup {
    task?: ClarityTask;
    /** Set when a substring matched several tasks, so the caller can list them instead of guessing. */
    ambiguous?: ClarityTask[];
}

/**
 * Find a catalogue task by name. An exact name wins outright; otherwise a case-insensitive
 * substring is accepted only when it matches exactly one task, because picking the first of
 * several would make the result depend on the order Clarity happened to return.
 */
export function findTaskByName(tasks: ClarityTask[], name: string): TaskNameLookup {
    const exact = tasks.find((task) => task.taskName === name);

    if (exact) {
        return { task: exact };
    }

    const needle = name.toLowerCase();
    const matches = tasks.filter((task) => task.taskName.toLowerCase().includes(needle));

    if (matches.length === 1) {
        return { task: matches[0] };
    }

    if (matches.length > 1) {
        return { ambiguous: matches };
    }

    return {};
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
        totalActuals: entry.totalActuals,
    }));
}
