import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import type { ExportedEntry } from "@app/azure-devops/lib/timelog/export";
import { getTimeLogApi } from "@app/azure-devops/lib/timelog-client";
import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { type ClarityMapping, requireConfig } from "@app/clarity/config";
import { getClarityApi } from "@app/clarity/lib/api";
import {
    discoverFillWeeks,
    executeFillPlan,
    type FillExecution,
    type FillPlan,
    type FillWriteOutcome,
    type IdleFillWeek,
    loadFillMonth,
    type PlannedFillEntry,
    planFill,
    type ReadyFillWeek,
} from "@app/clarity/lib/fill";
import type { UnmappedVerdict } from "@app/clarity/lib/fill-guard";
import type { TimelogEntry } from "@app/clarity/lib/fill-utils";
import type { TimesheetWeekReader } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityApi } from "@genesiscz/utils/clarity";
import { addDay, isDateInHalfOpenRange } from "@genesiscz/utils/date";

/**
 * One Clarity month fill behind every door: `tools clarity fill`, the dashboard's fill routes and the hub's Friday
 * timesheet. The preview IS the plan the execute writes, so a door can only render it, never plan its own rows.
 */

/**
 * The Clarity side of a fill: the saved task mappings and the timesheet calls. A narrow seam for a fake, not the
 * auth client class of `lib/auth/client.ts`.
 */
export interface ClarityClient
    extends TimesheetWeekReader,
        Pick<ClarityApi, "updateTimeEntryVerbose" | "createTimesheetNote"> {
    /** The ADO-to-Clarity task mappings. Throws when Clarity is not configured. */
    mappings(): Promise<ClarityMapping[]>;
}

/** The ADO side of a fill. */
export interface TimeLogSource {
    /** The TimeLog API of the configured user. Throws when the TimeLog setup is incomplete. */
    api(): TimeLogApi;
    /** Fills in work item titles and types before the entries are grouped. Only a door that shows titles needs it. */
    enrich?(entries: ExportedEntry[]): Promise<void>;
}

export interface MonthFillDeps {
    clarity: ClarityClient;
    timelog: TimeLogSource;
}

export interface MonthFillProgress {
    /** The plan, after every refusal check and before the first write. */
    onPlan?(plan: FillPlan): void;
    onWeek?(week: ReadyFillWeek): void;
    onWrite?(week: ReadyFillWeek, entry: PlannedFillEntry, outcome: FillWriteOutcome): void;
}

export interface MonthFillInput {
    month: number;
    year: number;
    /** Plan the mapped work although some work items have no mapping. */
    allowUnmapped?: boolean;
    /** Execute only: write just these timesheets, in this order. Absent: every week of the plan. */
    weekIds?: number[];
    /** Execute only: post the per-week timesheet note. */
    postNotes?: boolean;
    /** Execute only. */
    progress?: MonthFillProgress;
}

/** Why a month is not filled. The checks run in this order, and the first that holds is the refusal. */
export type FillRefusal =
    | { reason: "no_mappings" }
    | { reason: "no_ado_entries" }
    | { reason: "unmapped_work_items"; unmapped: UnmappedVerdict }
    | { reason: "all_unmapped"; entryCount: number; workItemCount: number }
    /** No opened Clarity week in the month at all. */
    | { reason: "no_timesheet_weeks"; unresolvedDates: string[] }
    /** Days with mapped hours that no opened period covers: a fill would drop them. */
    | { reason: "unresolved_dates"; unresolvedDates: string[] };

export interface MonthFillPreview {
    /** The weeks are empty when the month is refused. */
    plan: FillPlan;
    refusal?: FillRefusal;
}

export interface FillResult extends MonthFillPreview {
    /** Absent when the month is refused. */
    execution?: FillExecution;
}

export function liveClarityClient(): ClarityClient {
    let api: ClarityApi | undefined;
    const clarity = (): ClarityApi => {
        api ??= getClarityApi();
        return api;
    };

    return {
        mappings: async () => (await requireConfig()).mappings,
        getTimesheetApp: (timePeriodId) => clarity().getTimesheetApp(timePeriodId),
        getTimesheet: (timesheetId) => clarity().getTimesheet(timesheetId),
        updateTimeEntryVerbose: (...args) => clarity().updateTimeEntryVerbose(...args),
        createTimesheetNote: (...args) => clarity().createTimesheetNote(...args),
    };
}

/** The TimeLog API and the Azure DevOps config it was built from, through the one setup check, `getTimeLogApi`. */
export function connectTimeLog(): { api: TimeLogApi; config: AzureConfigWithTimeLog } {
    const config = loadAdoConfig() as AzureConfigWithTimeLog | null;
    const api = getTimeLogApi({ config: config ?? undefined });

    // getTimeLogApi refuses a missing config, so it is present here.
    return { api, config: config as AzureConfigWithTimeLog };
}

/**
 * The TimeLog source of the saved Azure DevOps config. `connect` is the one setup check (`getTimeLogApi`, or a door's
 * rewording of it); `titles` looks up the work item titles for a door that shows them, and a failed lookup leaves
 * the ids.
 */
export function liveTimeLogSource(
    options: { connect?: () => { api: TimeLogApi; config: AzureConfigWithTimeLog }; titles?: boolean } = {}
): TimeLogSource {
    let connected: { api: TimeLogApi; config: AzureConfigWithTimeLog } | undefined;
    const connect = () => {
        connected ??= (options.connect ?? connectTimeLog)();
        return connected;
    };

    if (!options.titles) {
        return { api: () => connect().api };
    }

    return {
        api: () => connect().api,
        enrich: async (entries) => {
            const ids = [...new Set(entries.map((entry) => entry.workItemId))];

            if (ids.length === 0) {
                return;
            }

            try {
                const workItems = await enrichWorkItems(connect().config, ids);

                for (const entry of entries) {
                    const workItem = workItems.get(entry.workItemId);

                    if (workItem) {
                        entry.workItemTitle = workItem.title;
                        entry.workItemType = workItem.type ?? "";
                    }
                }
            } catch {
                // Non-fatal: the titles show as "#ID".
            }
        },
    };
}

export function liveMonthFillDeps(options: Parameters<typeof liveTimeLogSource>[0] = {}): MonthFillDeps {
    return { clarity: liveClarityClient(), timelog: liveTimeLogSource(options) };
}

/** Load the month, run every refusal check, and plan every opened week. Reads ADO and Clarity, never writes. */
export async function previewMonthFill(input: MonthFillInput, deps: MonthFillDeps): Promise<MonthFillPreview> {
    const mappings = await deps.clarity.mappings();
    const adoApi = deps.timelog.api();
    const fill = await loadFillMonth({
        adoApi,
        mappings,
        month: input.month,
        year: input.year,
        allowUnmapped: input.allowUnmapped ?? false,
        enrich: deps.timelog.enrich?.bind(deps.timelog),
    });
    const refused = (refusal: FillRefusal, userId?: number): MonthFillPreview => ({
        plan: { month: input.month, year: input.year, userId, fill, weeks: [] },
        refusal,
    });

    if (mappings.length === 0) {
        return refused({ reason: "no_mappings" });
    }

    if (fill.adoExport.entries.length === 0) {
        return refused({ reason: "no_ado_entries" });
    }

    // An unmapped work item is the actionable problem, so it is checked before Clarity is read.
    if (fill.unmapped.blocked) {
        return refused({ reason: "unmapped_work_items", unmapped: fill.unmapped });
    }

    if (fill.fillMap.size === 0) {
        return refused({
            reason: "all_unmapped",
            entryCount: fill.adoExport.entries.length,
            workItemCount: fill.unmappedByWi.size,
        });
    }

    const discovery = await discoverFillWeeks(deps.clarity, fill);
    const { userId } = discovery.periods;

    if (discovery.weeks.length === 0) {
        return refused({ reason: "no_timesheet_weeks", unresolvedDates: discovery.unresolvedDates }, userId);
    }

    if (discovery.unresolvedDates.length > 0) {
        return refused({ reason: "unresolved_dates", unresolvedDates: discovery.unresolvedDates }, userId);
    }

    return { plan: await planFill({ api: deps.clarity, fill, discovery }) };
}

/** The plan narrowed to the requested timesheets, in their order; an id the month does not hold is `missing`. */
function selectWeeks(plan: FillPlan, weekIds: number[] | undefined): FillPlan {
    if (!weekIds) {
        return plan;
    }

    return {
        ...plan,
        weeks: weekIds.map(
            (timesheetId) =>
                plan.weeks.find((week) => week.timesheetId === timesheetId) ?? { status: "missing", timesheetId }
        ),
    };
}

/** Build the preview's plan again and write it. A refused month writes nothing. */
export async function executeMonthFill(input: MonthFillInput, deps: MonthFillDeps): Promise<FillResult> {
    const preview = await previewMonthFill(input, deps);

    if (preview.refusal) {
        return preview;
    }

    const plan = selectWeeks(preview.plan, input.weekIds);
    input.progress?.onPlan?.(plan);
    const execution = await executeFillPlan({
        api: deps.clarity,
        plan,
        postNotes: input.postNotes ?? false,
        onWeek: input.progress?.onWeek,
        onWrite: input.progress?.onWrite,
    });

    return { plan, execution };
}

export type ShownFillWeek = ReadyFillWeek | IdleFillWeek;

/** The weeks a preview shows, in date order: every planned week, idle ones included. */
export function shownWeeks(plan: FillPlan): ShownFillWeek[] {
    return plan.weeks
        .filter((week): week is ShownFillWeek => week.status === "ready" || week.status === "idle")
        .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

export interface MonthFillRow {
    entry: PlannedFillEntry;
    taskName: string;
    /** The code of the row the fill books on, else the mapped task's. */
    taskCode: string;
    /** ADO minutes per day inside the week. */
    minutesByDay: Record<string, number>;
    totalMinutes: number;
    timelogEntries: TimelogEntry[];
    /** What Clarity holds on the row now; null without a row. */
    clarityMinutes: number | null;
    clarityMinutesByDay: Record<string, number>;
}

/** The week's period as `YYYY-MM-DD` dates, the finish exclusive. */
export function weekRange(week: ShownFillWeek): { start: string; finishExclusive: string } {
    return {
        start: week.periodStart.split("T")[0],
        finishExclusive: addDay(week.periodFinishInclusive.split("T")[0]),
    };
}

export function minutesByDayOf(segments: Array<{ start: string; value: number }>): Record<string, number> {
    const byDay: Record<string, number> = {};

    for (const segment of segments) {
        byDay[segment.start.split("T")[0]] = Math.round(segment.value / 60);
    }

    return byDay;
}

/**
 * The rows a week shows: every entry that writes (a clear included), already holds its hours, or has work but no
 * row to book on. An entry with nothing to clear is left out.
 */
export function weekRows(week: ShownFillWeek): MonthFillRow[] {
    const { start, finishExclusive } = weekRange(week);
    const inWeek = (date: string) => isDateInHalfOpenRange(date, start, finishExclusive);

    return week.entries
        .filter((entry) => entry.action !== "nothing-to-clear")
        .map((entry) => {
            const minutesByDay = Object.fromEntries(
                Object.entries(entry.fill.dayMinutes).filter(([date]) => inWeek(date))
            );
            const clarityMinutesByDay = minutesByDayOf(entry.existingSegments);
            const claritySeconds = entry.existingSegments.reduce((sum, segment) => sum + segment.value, 0);

            return {
                entry,
                taskName: entry.fill.mapping.clarityTaskName,
                taskCode: entry.row?.taskCode ?? entry.fill.mapping.clarityTaskCode,
                minutesByDay,
                totalMinutes: Object.values(minutesByDay).reduce((sum, minutes) => sum + minutes, 0),
                timelogEntries: (entry.fill.timelogEntries ?? []).filter((source) => inWeek(source.date)),
                clarityMinutes: entry.row ? Math.round(claritySeconds / 60) : null,
                clarityMinutesByDay,
            };
        });
}

export type FillEntryOutcome = "written" | "failed" | "skipped";

/** How one planned entry of an executed fill ended. */
export function entryOutcome(entry: PlannedFillEntry, execution: FillExecution | undefined): FillEntryOutcome {
    const write = execution?.writes.get(entry);

    if (!write) {
        return "skipped";
    }

    return write.status === "success" ? "written" : "failed";
}

/** Entries written, failed and skipped; a week that could not be read counts as one failure. */
export function fillTally(result: FillResult): { written: number; failed: number; skipped: number } {
    const tally = { written: 0, failed: 0, skipped: 0 };

    for (const week of result.plan.weeks) {
        if (week.status === "missing" || week.status === "unreadable") {
            tally.failed++;
            continue;
        }

        for (const entry of week.entries) {
            tally[entryOutcome(entry, result.execution)]++;
        }
    }

    return tally;
}

/** A refusal in words for a page or the phone. The CLI words its own, with the commands to run. */
export function describeRefusal(refusal: FillRefusal, month: { month: number; year: number }): string {
    switch (refusal.reason) {
        case "no_mappings":
            return "No ADO-to-Clarity mappings configured. Create mappings on the Mappings page first.";
        case "no_ado_entries":
            return `No ADO timelog entries found for ${month.year}-${String(month.month).padStart(2, "0")}.`;
        case "unmapped_work_items":
            return `${refusal.unmapped.items.length} work item(s) carrying ${(refusal.unmapped.totalMinutes / 60).toFixed(1)}h have no Clarity mapping. Map them first, or re-run allowing unmapped work.`;
        case "all_unmapped":
            return `Found ${refusal.entryCount} ADO entries but none match configured mappings. ${refusal.workItemCount} work items are unmapped.`;
        case "no_timesheet_weeks":
            return "Could not resolve any Clarity timesheet week for this month. Check the Clarity session in Settings.";
        case "unresolved_dates":
            return `No Clarity period covers ${refusal.unresolvedDates.join(", ")}. Filling would drop those hours, so the month is refused.`;
    }
}
