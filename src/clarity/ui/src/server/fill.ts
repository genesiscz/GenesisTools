import { getClarityApi } from "@app/clarity/lib/api";
import type { FillEntryAction } from "@app/clarity/lib/fill";
import type { ExecuteFillResult, FillEntryResult } from "@app/clarity/lib/fill-utils";
import {
    describeRefusal,
    entryOutcome,
    executeMonthFill,
    type FillResult,
    liveMonthFillDeps,
    type MonthFillDeps,
    minutesByDayOf,
    previewMonthFill,
    type ShownFillWeek,
    shownWeeks,
    weekRange,
    weekRows,
} from "@app/clarity/lib/month-fill";
import { requireAdoTimeLogConfig } from "@app/clarity/ui/src/server/ado-config";

interface WeekPreviewTimelogEntry {
    workItemId: number;
    workItemTitle: string;
    workItemType: string;
    timeTypeDescription: string;
    comment: string | null;
    date: string;
    minutes: number;
}

interface WeekPreview {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    entries: Array<{
        clarityTaskName: string;
        clarityTaskCode: string;
        dayValues: Record<string, number>;
        totalMinutes: number;
        timelogEntries: WeekPreviewTimelogEntry[];
        clarityCurrentMinutes?: number;
        clarityDayValues?: Record<string, number>;
        clarityOnly?: boolean;
        /** What the fill does with the row; absent on a Clarity-only row. `no-row`: the hours cannot be booked. */
        action?: Exclude<FillEntryAction, "nothing-to-clear">;
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
    clarityTotalMinutes?: number;
    hasNotes?: boolean;
    numberOfNotes?: number;
}

export interface FillPreviewResult {
    weeks: WeekPreview[];
    totalMapped: number;
    totalUnmapped: number;
    adoConfig?: { org: string; project: string };
    userId?: number;
    /** Days carrying mapped hours that no Clarity period covers. The write drops those hours. */
    unresolvedDates?: string[];
    /** Weeks of the month whose timesheet could not be read; the fill cannot write them. */
    unreadableWeeks?: Array<{ timesheetId: number; error: string }>;
    diagnostics?: {
        reason: string;
        message: string;
    };
}

/** The dashboard's fill clients: the TimeLog setup check worded for the Settings page, and the org for links. */
export function dashboardFillDeps(options: { titles?: boolean } = {}): {
    deps: MonthFillDeps;
    adoInfo: () => { org: string; project: string } | undefined;
} {
    let ado: ReturnType<typeof requireAdoTimeLogConfig> | undefined;
    const deps = liveMonthFillDeps({
        titles: options.titles,
        connect: () => {
            ado ??= requireAdoTimeLogConfig();
            return ado;
        },
    });

    return { deps, adoInfo: () => (ado ? { org: ado.config.org, project: ado.config.project } : undefined) };
}

function renderWeek(week: ShownFillWeek): WeekPreview {
    const { start, finishExclusive } = weekRange(week);
    const rows = weekRows(week);
    const bookedRows = new Set(rows.flatMap((row) => (row.entry.row ? [row.entry.row.timeEntryId] : [])));
    const entries: WeekPreview["entries"] = rows.map((row) => ({
        clarityTaskName: row.taskName,
        clarityTaskCode: row.taskCode,
        dayValues: row.minutesByDay,
        totalMinutes: row.totalMinutes,
        timelogEntries: row.timelogEntries,
        clarityCurrentMinutes: row.clarityMinutes ?? 0,
        clarityDayValues: row.clarityMinutesByDay,
        action: row.entry.action === "nothing-to-clear" ? undefined : row.entry.action,
    }));
    let clarityTotalMinutes = 0;

    for (const clarityRow of week.clarityRows) {
        const minutes = Math.round(clarityRow.segments.reduce((sum, segment) => sum + segment.value, 0) / 60);
        clarityTotalMinutes += minutes;

        if (bookedRows.has(clarityRow.timeEntryId) || minutes === 0) {
            continue;
        }

        // Hours Clarity holds on a row this fill leaves alone.
        entries.push({
            clarityTaskName: clarityRow.taskName,
            clarityTaskCode: clarityRow.taskCode,
            dayValues: {},
            totalMinutes: 0,
            timelogEntries: [],
            clarityCurrentMinutes: minutes,
            clarityDayValues: minutesByDayOf(clarityRow.segments),
            clarityOnly: true,
        });
    }

    return {
        timesheetId: week.timesheetId,
        periodStart: start,
        periodFinish: finishExclusive,
        entries,
        unmappedWorkItems: week.unmappedWorkItems,
        clarityTotalMinutes,
        hasNotes: week.existingNotes > 0,
        numberOfNotes: week.existingNotes,
    };
}

export async function getFillPreview(month: number, year: number, allowUnmapped = false): Promise<FillPreviewResult> {
    const { deps, adoInfo } = dashboardFillDeps({ titles: true });
    const { plan, refusal } = await previewMonthFill({ month, year, allowUnmapped }, deps);
    const totalMapped = [...plan.fill.fillMap.values()].reduce((sum, fill) => sum + fill.totalMinutes, 0);
    const totalUnmapped = [...plan.fill.unmappedByWi.values()].reduce((sum, minutes) => sum + minutes, 0);
    const base = { totalMapped, totalUnmapped, adoConfig: adoInfo(), userId: plan.userId };

    if (refusal) {
        return {
            ...base,
            weeks: [],
            ...("unresolvedDates" in refusal ? { unresolvedDates: refusal.unresolvedDates } : {}),
            diagnostics: { reason: refusal.reason, message: describeRefusal(refusal, { month, year }) },
        };
    }

    const unreadableWeeks = plan.weeks.flatMap((week) =>
        week.status === "unreadable" || week.status === "missing"
            ? [
                  {
                      timesheetId: week.timesheetId,
                      error: week.status === "missing" ? "came back empty" : String(week.error),
                  },
              ]
            : []
    );

    return {
        ...base,
        weeks: shownWeeks(plan).map(renderWeek),
        ...(unreadableWeeks.length > 0 ? { unreadableWeeks } : {}),
    };
}

export async function postTimesheetNote(timesheetId: number, noteText: string, userId: number): Promise<void> {
    const clarityApi = getClarityApi();

    await clarityApi.createTimesheetNote(timesheetId, noteText, userId);
}

const SkipReasons = {
    "nothing-to-clear": "No minutes for this task in this week",
    unchanged: "Clarity already holds these hours",
} as const;

/** Every task of every requested week, with what the fill did to it. */
export function renderFillResult(result: FillResult): ExecuteFillResult {
    const counts = { success: 0, failed: 0, skipped: 0 };
    const entries: FillEntryResult[] = [];

    for (const week of result.plan.weeks) {
        const timesheetId = week.timesheetId;

        if (week.status === "missing" || week.status === "unreadable") {
            entries.push({
                clarityTaskName: `Timesheet #${timesheetId}`,
                clarityTaskCode: "",
                timesheetId,
                timeEntryId: 0,
                totalHours: 0,
                segments: [],
                status: "error",
                error: week.status === "missing" ? `Timesheet ${timesheetId} not found` : String(week.error),
            });
            counts.failed++;
            continue;
        }

        for (const entry of week.entries) {
            const base = {
                clarityTaskName: entry.fill.mapping.clarityTaskName,
                clarityTaskCode: entry.row?.taskCode ?? entry.fill.mapping.clarityTaskCode,
                timesheetId,
            };
            const outcome = entryOutcome(entry, result.execution);
            const write = result.execution?.writes.get(entry);

            if (!entry.row) {
                entries.push({
                    ...base,
                    timeEntryId: 0,
                    totalHours: 0,
                    segments: [],
                    status: "skipped",
                    error: `No time entry for task in timesheet ${timesheetId}`,
                });
                counts.skipped++;
                continue;
            }

            // A row with a write always has its outcome; any other row was left as it is.
            if (!write) {
                entries.push({
                    ...base,
                    timeEntryId: entry.row.timeEntryId,
                    totalHours: 0,
                    segments: [],
                    status: "skipped",
                    error: entry.action === "unchanged" ? SkipReasons.unchanged : SkipReasons["nothing-to-clear"],
                });
                counts.skipped++;
                continue;
            }

            entries.push({
                ...base,
                timeEntryId: entry.row.timeEntryId,
                totalHours: write.totalSeconds / 3600,
                segments: entry.segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => ({ date: segment.start.split("T")[0], hours: segment.value / 3600 })),
                status: outcome === "written" ? "success" : "error",
                ...(write.status === "error" ? { error: write.error } : {}),
                debug: write.debug,
            });

            if (outcome === "written") {
                counts.success++;
            } else {
                counts.failed++;
            }
        }
    }

    return { ...counts, entries };
}

export async function executeFill(
    month: number,
    year: number,
    weekIds: number[],
    allowUnmapped = false
): Promise<ExecuteFillResult> {
    const result = await executeMonthFill({ month, year, weekIds, allowUnmapped }, dashboardFillDeps().deps);

    // The preview refusing only stops the client from OFFERING the write; this path books hours from weekIds it
    // takes straight from the request, so it refuses on its own result.
    if (result.refusal) {
        throw new Error(`Refusing to fill: ${describeRefusal(result.refusal, { month, year })}`);
    }

    return renderFillResult(result);
}
