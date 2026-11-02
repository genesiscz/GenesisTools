import { type ExportedEntry, exportMonth, type MonthExport } from "@app/azure-devops/lib/timelog/export";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { ClarityMapping } from "@app/clarity/config";
import { buildPeriodComment, type CommentEntry } from "@app/clarity/lib/comment-builder";
import { checkUnmapped, type UnmappedVerdict } from "@app/clarity/lib/fill-guard";
import {
    buildFillMap,
    buildMonthAwareTimeSegments,
    type FillEntry,
    fillMinutesInPeriod,
    replacementChangesActuals,
    requestedMonthActualSeconds,
    type UnmappedEntry,
} from "@app/clarity/lib/fill-utils";
import { type ResolvedFillWeeks, resolveFillWeeks } from "@app/clarity/lib/fill-weeks";
import type { TimesheetRecord, TimesheetWeekReader } from "@app/clarity/lib/timesheet-weeks";
import type { ApiDebugInfo, ClarityApi, TimeEntryRecord, TimeSegment, TimeSeriesValue } from "@genesiscz/utils/clarity";
import { addDay, isDateInHalfOpenRange } from "@genesiscz/utils/date";

/** One month of ADO time, grouped by Clarity task. */
export interface FillMonth {
    month: number;
    year: number;
    adoExport: MonthExport;
    fillMap: Map<number, FillEntry>;
    unmappedByWi: Map<number, number>;
    unmappedEntries: UnmappedEntry[];
    unmapped: UnmappedVerdict;
    /** Sorted days that carry mapped minutes. */
    dates: string[];
}

export async function loadFillMonth({
    adoApi,
    mappings,
    month,
    year,
    allowUnmapped,
    enrich,
}: {
    adoApi: TimeLogApi;
    mappings: ClarityMapping[];
    month: number;
    year: number;
    allowUnmapped: boolean;
    /** Fills in work item titles and types before the entries are grouped. */
    enrich?: (entries: ExportedEntry[]) => Promise<void>;
}): Promise<FillMonth> {
    const adoExport = await exportMonth(adoApi, month, year, adoApi.user.userId);

    if (enrich) {
        await enrich(adoExport.entries);
    }

    const { fillMap, unmappedByWi, unmappedEntries } = buildFillMap(adoExport.entries, mappings, {
        trackEntries: true,
    });
    const dates = [...new Set([...fillMap.values()].flatMap((fill) => Object.keys(fill.dayMinutes)))].sort();

    return {
        month,
        year,
        adoExport,
        fillMap,
        unmappedByWi,
        unmappedEntries,
        unmapped: checkUnmapped({ unmappedByWi, allowUnmapped }),
        dates,
    };
}

/** Every opened timesheet week of the month, and the fill days no opened period covers. */
export function discoverFillWeeks(api: TimesheetWeekReader, fill: FillMonth): Promise<ResolvedFillWeeks> {
    return resolveFillWeeks({
        api,
        dates: fill.dates,
        month: fill.month,
        year: fill.year,
        includeMonthWeeks: true,
    });
}

/** Unmapped minutes per work item inside one period, in first-seen order. */
export function unmappedInPeriod(
    entries: UnmappedEntry[],
    periodStart: string,
    periodFinishExclusive: string
): Array<{ workItemId: number; minutes: number }> {
    const byWorkItem = new Map<number, number>();

    for (const entry of entries) {
        if (isDateInHalfOpenRange(entry.date, periodStart, periodFinishExclusive)) {
            byWorkItem.set(entry.workItemId, (byWorkItem.get(entry.workItemId) ?? 0) + entry.minutes);
        }
    }

    return [...byWorkItem.entries()].map(([workItemId, minutes]) => ({ workItemId, minutes }));
}

/**
 * - `write`: the replacement changes the row.
 * - `unchanged`: Clarity already holds exactly these hours.
 * - `nothing-to-clear`: no ADO minutes this week and no requested-month hours to clear.
 * - `no-row`: the timesheet has no row for the task.
 */
export type FillEntryAction = "write" | "unchanged" | "nothing-to-clear" | "no-row";

export interface PlannedFillEntry {
    fill: FillEntry;
    action: FillEntryAction;
    row?: { timeEntryId: number; taskId: number };
    existingSegments: TimeSegment[];
    /** The whole-period replacement, for `write` and `unchanged`. */
    segments: TimeSegment[];
}

export interface ReadyFillWeek {
    status: "ready";
    timesheetId: number;
    periodStart: string;
    /** Clarity's `timePeriodFinish`: the LAST day of the period. */
    periodFinishInclusive: string;
    existingNotes: number;
    entries: PlannedFillEntry[];
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
}

export type PlannedFillWeek =
    | ReadyFillWeek
    | { status: "unreadable"; timesheetId: number; startDate: string; error: unknown }
    | { status: "missing"; timesheetId: number; startDate?: string };

export interface FillPlan {
    month: number;
    year: number;
    /** Clarity user id, the author of a timesheet note. */
    userId?: number;
    weeks: PlannedFillWeek[];
}

/**
 * Which weeks a plan covers.
 * - `discovered`: every opened week of the month, reusing the reads discovery made. A failed read
 *   marks the week unreadable, and a clearing-only week with nothing to write is left out.
 * - `requested`: exactly these timesheet ids, each read again. A failed read fails the plan.
 */
export type FillWeekSelection = "discovered" | { requested: number[] };

/**
 * Where a missing row is reported.
 * - `tasks-with-work`: only for a task with minutes or requested-month hours in the week.
 * - `every-task`: for every mapped task, before anything else is checked.
 */
export type MissingRowReporting = "tasks-with-work" | "every-task";

function exclusiveEnd(periodFinishInclusive: string): string {
    return `${addDay(periodFinishInclusive.split("T")[0])}T00:00:00`;
}

function planEntry({
    fill,
    record,
    month,
    year,
    missingRows,
}: {
    fill: FillEntry;
    record: TimesheetRecord;
    month: number;
    year: number;
    missingRows: MissingRowReporting;
}): PlannedFillEntry {
    const periodFinishExclusive = exclusiveEnd(record.timePeriodFinish);
    const timeEntry = record.timeentries._results.find(
        (entry: TimeEntryRecord) => entry.taskId === fill.mapping.clarityTaskId
    );
    // A row with no actuals yet comes back without the series.
    const existingSegments = timeEntry?.actuals?.segmentList?.segments ?? [];
    // A week with no ADO minutes is written only to clear requested-month hours Clarity still holds.
    const nothingToClear =
        fillMinutesInPeriod(fill.dayMinutes, record.timePeriodStart, periodFinishExclusive) === 0 &&
        requestedMonthActualSeconds(existingSegments, { year, month }) === 0;

    if (!timeEntry) {
        const action = missingRows === "tasks-with-work" && nothingToClear ? "nothing-to-clear" : "no-row";

        return { fill, action, existingSegments, segments: [] };
    }

    const row = { timeEntryId: timeEntry._internalId, taskId: timeEntry.taskId };

    if (nothingToClear) {
        return { fill, action: "nothing-to-clear", row, existingSegments, segments: [] };
    }

    const segments = buildMonthAwareTimeSegments({
        periodStart: record.timePeriodStart,
        periodFinishExclusive,
        year,
        month,
        dayMinutes: fill.dayMinutes,
        existingSegments,
    });
    const action = replacementChangesActuals(segments, existingSegments) ? "write" : "unchanged";

    return { fill, action, row, existingSegments, segments };
}

function planWeek({
    timesheetId,
    record,
    fill,
    missingRows,
}: {
    timesheetId: number;
    record: TimesheetRecord;
    fill: FillMonth;
    missingRows: MissingRowReporting;
}): ReadyFillWeek {
    return {
        status: "ready",
        timesheetId,
        periodStart: record.timePeriodStart,
        periodFinishInclusive: record.timePeriodFinish,
        existingNotes: record.numberOfNotes ?? 0,
        entries: [...fill.fillMap.values()].map((entry) =>
            planEntry({ fill: entry, record, month: fill.month, year: fill.year, missingRows })
        ),
        unmappedWorkItems: unmappedInPeriod(
            fill.unmappedEntries,
            record.timePeriodStart,
            exclusiveEnd(record.timePeriodFinish)
        ),
    };
}

/** Decide, per week and mapped task, what a fill would write and why. Reads Clarity, never writes. */
export async function planFill({
    api,
    fill,
    discovery,
    weeks,
    missingRows,
}: {
    api: Pick<ClarityApi, "getTimesheet">;
    fill: FillMonth;
    discovery: ResolvedFillWeeks;
    weeks: FillWeekSelection;
    missingRows: MissingRowReporting;
}): Promise<FillPlan> {
    const planned: PlannedFillWeek[] = [];

    if (weeks === "discovered") {
        for (const week of discovery.weeks) {
            let record = discovery.records.get(week.timesheetId);

            try {
                record ??= (await api.getTimesheet(week.timesheetId)).timesheets._results[0];
            } catch (error) {
                planned.push({ status: "unreadable", timesheetId: week.timesheetId, startDate: week.startDate, error });
                continue;
            }

            if (!record) {
                planned.push({ status: "missing", timesheetId: week.timesheetId, startDate: week.startDate });
                continue;
            }

            const plan = planWeek({ timesheetId: record._internalId, record, fill, missingRows });
            const idle = plan.entries.every((entry) => entry.action === "nothing-to-clear");

            if (discovery.clearingOnlyWeekIds.has(week.timesheetId) && idle) {
                continue;
            }

            planned.push(plan);
        }
    } else {
        for (const timesheetId of weeks.requested) {
            const record = (await api.getTimesheet(timesheetId)).timesheets._results[0];

            planned.push(
                record ? planWeek({ timesheetId, record, fill, missingRows }) : { status: "missing", timesheetId }
            );
        }
    }

    return { month: fill.month, year: fill.year, userId: discovery.userId, weeks: planned };
}

export function readyWeeks(plan: FillPlan): ReadyFillWeek[] {
    return plan.weeks.filter((week): week is ReadyFillWeek => week.status === "ready");
}

function commentEntries(entries: PlannedFillEntry[]): CommentEntry[] {
    return entries.flatMap((entry) =>
        (entry.fill.timelogEntries ?? []).map((source) => ({
            workItemId: source.workItemId,
            timeTypeDescription: source.timeTypeDescription ?? "",
            comment: source.comment ?? null,
            date: source.date,
        }))
    );
}

/** The timesheet note for a week, built from the ADO entries of the given planned entries. */
export function weekNote(week: ReadyFillWeek, entries: PlannedFillEntry[]): string {
    return buildPeriodComment({
        entries: commentEntries(entries),
        periodStart: week.periodStart,
        periodFinishInclusive: week.periodFinishInclusive,
    });
}

export interface FillWriteOutcome {
    status: "success" | "error";
    totalSeconds: number;
    debug?: ApiDebugInfo;
    error?: string;
}

export interface FillNoteOutcome {
    timesheetId: number;
    status: "posted" | "kept-existing" | "failed";
    existingNotes: number;
    error?: unknown;
}

export interface FillExecution {
    writes: Map<PlannedFillEntry, FillWriteOutcome>;
    /** Absent unless notes were asked for. */
    notes?: { missingUserId: boolean; weeks: FillNoteOutcome[] };
}

function actualsFor(week: ReadyFillWeek, segments: TimeSegment[]): TimeSeriesValue {
    return {
        isFiscal: false,
        curveType: "value",
        dataType: "numeric",
        _type: "tsv",
        start: week.periodStart,
        finish: week.periodFinishInclusive,
        segmentList: {
            total: segments.reduce((sum, segment) => sum + segment.value, 0),
            defaultValue: 0,
            segments,
        },
    };
}

/**
 * Write every `write` entry of the ready weeks. With `postNotes`, each week then gets a note built
 * from the entries that actually wrote, unless the timesheet already carries one.
 */
export async function executeFillPlan({
    api,
    plan,
    postNotes,
    onWeek,
    onWrite,
}: {
    api: Pick<ClarityApi, "updateTimeEntryVerbose" | "createTimesheetNote">;
    plan: FillPlan;
    postNotes: boolean;
    onWeek?: (week: ReadyFillWeek) => void;
    onWrite?: (week: ReadyFillWeek, entry: PlannedFillEntry, outcome: FillWriteOutcome) => void;
}): Promise<FillExecution> {
    const writes = new Map<PlannedFillEntry, FillWriteOutcome>();
    const weeks = readyWeeks(plan);

    for (const week of weeks) {
        onWeek?.(week);

        for (const entry of week.entries) {
            if (entry.action !== "write" || !entry.row) {
                continue;
            }

            const actuals = actualsFor(week, entry.segments);
            let outcome: FillWriteOutcome;

            try {
                const { debug } = await api.updateTimeEntryVerbose(week.timesheetId, entry.row.timeEntryId, {
                    taskId: entry.row.taskId,
                    actuals,
                });
                outcome = { status: "success", totalSeconds: actuals.segmentList.total, debug };
            } catch (err) {
                outcome = {
                    status: "error",
                    totalSeconds: actuals.segmentList.total,
                    error: err instanceof Error ? err.message : String(err),
                    debug: (err as Error & { debug?: ApiDebugInfo }).debug,
                };
            }

            writes.set(entry, outcome);
            onWrite?.(week, entry, outcome);
        }
    }

    if (!postNotes) {
        return { writes };
    }

    const userId = plan.userId;

    if (userId === undefined) {
        return { writes, notes: { missingUserId: true, weeks: [] } };
    }

    const notes: FillNoteOutcome[] = [];

    for (const week of weeks) {
        // The note documents what was booked: unmapped work and failed writes stay out of it.
        const booked = week.entries.filter((entry) => writes.get(entry)?.status === "success");
        const text = weekNote(week, booked);

        if (!text) {
            continue;
        }

        if (week.existingNotes > 0) {
            notes.push({ timesheetId: week.timesheetId, status: "kept-existing", existingNotes: week.existingNotes });
            continue;
        }

        try {
            await api.createTimesheetNote(week.timesheetId, text, userId);
            notes.push({ timesheetId: week.timesheetId, status: "posted", existingNotes: 0 });
        } catch (error) {
            notes.push({ timesheetId: week.timesheetId, status: "failed", existingNotes: 0, error });
        }
    }

    return { writes, notes: { missingUserId: false, weeks: notes } };
}
