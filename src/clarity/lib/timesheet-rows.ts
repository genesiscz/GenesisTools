import { listClarityTasks, type TimesheetReader } from "@app/clarity/lib/tasks";

/** A task the caller wants on a week. The name is only for reporting; Clarity needs the id. */
export interface DesiredTask {
    taskId: number;
    taskName?: string;
}

export interface TaskRowWriter extends TimesheetReader {
    createTimeEntry(timesheetId: number, taskId: number): Promise<unknown>;
    deleteTimeEntry(timesheetId: number, timeEntryId: number): Promise<unknown>;
}

export interface AddRowsResult {
    added: DesiredTask[];
    skipped: DesiredTask[];
    failed: Array<DesiredTask & { error: string }>;
}

export interface RemoveRowsResult {
    removed: DesiredTask[];
    /** Rows left alone because they carry booked hours, or because the server did not say. */
    blocked: Array<DesiredTask & { hours: number | undefined }>;
    missing: number[];
    failed: Array<DesiredTask & { error: string }>;
}

/** Split the wanted tasks against the ids a week already carries, keeping each task once. */
export function diffCatalogue({ have, want }: { have: number[]; want: DesiredTask[] }): {
    present: DesiredTask[];
    missing: DesiredTask[];
} {
    const existing = new Set(have);
    const seen = new Set<number>();
    const present: DesiredTask[] = [];
    const missing: DesiredTask[] = [];

    for (const task of want) {
        if (seen.has(task.taskId)) {
            continue;
        }

        seen.add(task.taskId);
        (existing.has(task.taskId) ? present : missing).push(task);
    }

    return { present, missing };
}

function named(task: DesiredTask, names: Map<number, string>): DesiredTask {
    const taskName = task.taskName ?? names.get(task.taskId);

    return taskName === undefined ? { taskId: task.taskId } : { taskId: task.taskId, taskName };
}

/**
 * Put the wanted task rows on a week, posting only the ones it does not already carry. A failed
 * post is recorded rather than thrown, so one rejected task cannot lose the rest of the batch.
 */
export async function addTaskRows({
    api,
    timesheetId,
    want,
}: {
    api: TaskRowWriter;
    timesheetId: number;
    want: DesiredTask[];
}): Promise<AddRowsResult> {
    const rows = await listClarityTasks({ api, timesheetId });
    const names = new Map(rows.map((row) => [row.taskId, row.taskName]));
    const { present, missing } = diffCatalogue({ have: [...names.keys()], want });

    const result: AddRowsResult = {
        added: [],
        skipped: present.map((task) => named(task, names)),
        failed: [],
    };

    for (const task of missing) {
        try {
            await api.createTimeEntry(timesheetId, task.taskId);
            result.added.push(task);
        } catch (err) {
            result.failed.push({ ...task, error: err instanceof Error ? err.message : String(err) });
        }
    }

    return result;
}

/**
 * Drop task rows from a week. A row carrying actuals is left alone: deleting it throws the booked
 * hours away and Clarity asks for no confirmation of its own.
 */
export async function removeTaskRows({
    api,
    timesheetId,
    taskIds,
}: {
    api: TaskRowWriter;
    timesheetId: number;
    taskIds: number[];
}): Promise<RemoveRowsResult> {
    const rows = await listClarityTasks({ api, timesheetId });
    const byTaskId = new Map(rows.map((row) => [row.taskId, row]));
    const result: RemoveRowsResult = { removed: [], blocked: [], missing: [], failed: [] };

    for (const taskId of new Set(taskIds)) {
        const row = byTaskId.get(taskId);

        if (!row) {
            result.missing.push(taskId);
            continue;
        }

        const task = { taskId, taskName: row.taskName };

        // Fails CLOSED: only a real, finite zero proves the row is empty. `null` and `NaN` both
        // answer false to `> 0`, so a check against `undefined` alone would delete booked hours.
        const actuals =
            typeof row.totalActuals === "number" && Number.isFinite(row.totalActuals) ? row.totalActuals : undefined;

        if (actuals === undefined || actuals !== 0) {
            result.blocked.push({ ...task, hours: actuals === undefined ? undefined : actuals / 3600 });
            continue;
        }

        try {
            await api.deleteTimeEntry(timesheetId, row.timeEntryId);
            result.removed.push(task);
        } catch (err) {
            result.failed.push({ ...task, error: err instanceof Error ? err.message : String(err) });
        }
    }

    return result;
}
