import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import { requireConfig } from "@app/clarity/config";
import { getClarityApi } from "@app/clarity/lib/api";
import { discoverFillWeeks, executeFillPlan, loadFillMonth, planFill, unmappedInPeriod } from "@app/clarity/lib/fill";
import type { ExecuteFillResult, FillEntryResult } from "@app/clarity/lib/fill-utils";
import { getTimesheetRecord } from "@app/clarity/lib/timesheet-weeks";
import { requireAdoTimeLogConfig } from "@app/clarity/ui/src/server/ado-config";
import type { TimeEntryRecord } from "@genesiscz/utils/clarity";

import { isDateInHalfOpenRange } from "@genesiscz/utils/date";

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
    diagnostics?: {
        reason: string;
        message: string;
    };
}

export async function getFillPreview(month: number, year: number, allowUnmapped = false): Promise<FillPreviewResult> {
    const clarityConfig = await requireConfig();
    const clarityApi = getClarityApi();
    const { config: adoConfig, api: adoApi } = requireAdoTimeLogConfig();

    const fill = await loadFillMonth({
        adoApi,
        mappings: clarityConfig.mappings,
        month,
        year,
        allowUnmapped,
        enrich: async (entries) => {
            const uniqueIds = [...new Set(entries.map((e) => e.workItemId))];

            if (uniqueIds.length === 0) {
                return;
            }

            try {
                const workItems = await enrichWorkItems(adoConfig, uniqueIds);

                for (const entry of entries) {
                    const wi = workItems.get(entry.workItemId);

                    if (wi) {
                        entry.workItemTitle = wi.title;
                        entry.workItemType = wi.type ?? "";
                    }
                }
            } catch {
                // Non-fatal — titles will show as "#ID"
            }
        },
    });
    const { fillMap, unmappedByWi, adoExport, unmapped } = fill;

    const totalMapped = [...fillMap.values()].reduce((s, f) => s + f.totalMinutes, 0);
    const totalUnmapped = [...unmappedByWi.values()].reduce((s, v) => s + v, 0);
    const adoInfo = { org: adoConfig.org, project: adoConfig.project };

    if (clarityConfig.mappings.length === 0) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            diagnostics: {
                reason: "no_mappings",
                message: "No ADO-to-Clarity mappings configured. Create mappings on the Mappings page first.",
            },
        };
    }

    if (fillMap.size === 0 && adoExport.entries.length === 0) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            diagnostics: {
                reason: "no_ado_entries",
                message: `No ADO timelog entries found for ${year}-${String(month).padStart(2, "0")}.`,
            },
        };
    }

    if (fillMap.size === 0 && adoExport.entries.length > 0) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            diagnostics: {
                reason: "all_unmapped",
                message: `Found ${adoExport.entries.length} ADO entries but none match configured mappings. ${unmappedByWi.size} work items are unmapped.`,
            },
        };
    }

    // Checked before week discovery, the order the CLI uses: an unmapped work item is the
    // actionable problem and must not sit behind an unrelated one.
    if (unmapped.blocked) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            adoConfig: adoInfo,
            diagnostics: {
                reason: "unmapped_work_items",
                message: `${unmapped.items.length} work item(s) carrying ${(unmapped.totalMinutes / 60).toFixed(1)}h have no Clarity mapping. Map them first, or re-run allowing unmapped work.`,
            },
        };
    }

    const { weeks: discovered, unresolvedDates, userId, records } = await discoverFillWeeks(clarityApi, fill);
    // Discovery lists the weeks carrying fill dates first; the preview shows the month in date order.
    const clarityWeeks = [...discovered].sort((a, b) => a.startDate.localeCompare(b.startDate));

    if (clarityWeeks.length === 0) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            unresolvedDates,
            adoConfig: adoInfo,
            userId,
            diagnostics: {
                reason: "no_timesheet_weeks",
                message:
                    "Could not resolve any Clarity timesheet week for this month. Check the Clarity session in Settings.",
            },
        };
    }

    if (unresolvedDates.length > 0) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            unresolvedDates,
            adoConfig: adoInfo,
            userId,
            diagnostics: {
                reason: "unresolved_dates",
                message: `No Clarity period covers ${unresolvedDates.join(", ")}. Filling would drop those hours, so the preview refuses the month.`,
            },
        };
    }

    const weekPreviews: WeekPreview[] = [];

    for (const cw of clarityWeeks) {
        const weekEntries: WeekPreview["entries"] = [];

        for (const fillEntry of fillMap.values()) {
            const weekDayValues: Record<string, number> = {};
            let weekTotal = 0;

            for (const [date, mins] of Object.entries(fillEntry.dayMinutes)) {
                if (isDateInHalfOpenRange(date, cw.startDate, cw.finishDate)) {
                    weekDayValues[date] = mins;
                    weekTotal += mins;
                }
            }

            if (weekTotal > 0) {
                const weekTimelogs = (fillEntry.timelogEntries ?? []).filter((e) =>
                    isDateInHalfOpenRange(e.date, cw.startDate, cw.finishDate)
                );

                weekEntries.push({
                    clarityTaskName: fillEntry.mapping.clarityTaskName,
                    clarityTaskCode: fillEntry.mapping.clarityTaskCode,
                    dayValues: weekDayValues,
                    totalMinutes: weekTotal,
                    timelogEntries: weekTimelogs,
                });
            }
        }

        weekPreviews.push({
            timesheetId: cw.timesheetId,
            periodStart: cw.startDate,
            periodFinish: cw.finishDate,
            entries: weekEntries,
            unmappedWorkItems: unmappedInPeriod(fill.unmappedEntries, cw.startDate, cw.finishDate),
        });
    }

    // Fetch current Clarity state for each week (parallel)
    await Promise.all(
        weekPreviews.map(async (wp) => {
            try {
                const ts = await getTimesheetRecord({ api: clarityApi, records, timesheetId: wp.timesheetId });

                if (!ts) {
                    return;
                }

                const matchedTaskCodes = new Set<string>();

                for (const entry of wp.entries) {
                    const te = ts.timeentries._results.find(
                        (e: TimeEntryRecord) => e.taskCode === entry.clarityTaskCode
                    );
                    const totalSeconds = te?.actuals?.segmentList?.total ?? 0;
                    entry.clarityCurrentMinutes = Math.round(totalSeconds / 60);

                    // Extract per-day values from Clarity segments
                    const dayValues: Record<string, number> = {};

                    for (const seg of te?.actuals?.segmentList?.segments ?? []) {
                        const date = seg.start.split("T")[0];
                        dayValues[date] = Math.round(seg.value / 60);
                    }

                    entry.clarityDayValues = dayValues;
                    matchedTaskCodes.add(entry.clarityTaskCode);
                }

                // Add Clarity-only entries (tasks with hours in Clarity but no ADO mapping)
                for (const te of ts.timeentries._results as TimeEntryRecord[]) {
                    if (matchedTaskCodes.has(te.taskCode)) {
                        continue;
                    }

                    const totalSeconds = te.actuals?.segmentList?.total ?? 0;

                    if (totalSeconds === 0) {
                        continue;
                    }

                    const dayValues: Record<string, number> = {};

                    for (const seg of te.actuals?.segmentList?.segments ?? []) {
                        const date = seg.start.split("T")[0];
                        dayValues[date] = Math.round(seg.value / 60);
                    }

                    wp.entries.push({
                        clarityTaskName: te.taskName,
                        clarityTaskCode: te.taskCode,
                        dayValues: {},
                        totalMinutes: 0,
                        timelogEntries: [],
                        clarityCurrentMinutes: Math.round(totalSeconds / 60),
                        clarityDayValues: dayValues,
                        clarityOnly: true,
                    });
                }

                // Sum total from ALL Clarity timesheet entries (not just ADO-matched ones)
                let weekClarityTotal = 0;

                for (const te of ts.timeentries._results) {
                    weekClarityTotal += Math.round(((te as TimeEntryRecord).actuals?.segmentList?.total ?? 0) / 60);
                }

                wp.clarityTotalMinutes = weekClarityTotal;
                wp.hasNotes = ts.hasNotes ?? false;
                wp.numberOfNotes = ts.numberOfNotes ?? 0;
            } catch {
                // Non-fatal — clarity state indicators will be absent
            }
        })
    );

    return {
        weeks: weekPreviews,
        totalMapped,
        totalUnmapped,
        adoConfig: adoInfo,
        userId,
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

export async function executeFill(
    month: number,
    year: number,
    weekIds: number[],
    allowUnmapped = false
): Promise<ExecuteFillResult> {
    const clarityConfig = await requireConfig();
    const clarityApi = getClarityApi();
    const { api: adoApi } = requireAdoTimeLogConfig();

    const fill = await loadFillMonth({ adoApi, mappings: clarityConfig.mappings, month, year, allowUnmapped });

    // The preview refusing is not a guard: it only stops the client from OFFERING the write. This
    // is the path that actually books hours, and it takes weekIds straight from the request.
    if (fill.unmapped.blocked) {
        throw new Error(
            `Refusing to fill: ${fill.unmapped.items.length} work item(s) carrying ${(fill.unmapped.totalMinutes / 60).toFixed(1)}h have no Clarity mapping.`
        );
    }

    // The sibling check. Hours on a day no opened period covers are never written, and the response
    // would still report success for the weeks that did write.
    const discovery = await discoverFillWeeks(clarityApi, fill);

    if (discovery.unresolvedDates.length > 0) {
        throw new Error(`Refusing to fill: no Clarity period covers ${discovery.unresolvedDates.join(", ")}.`);
    }

    const plan = await planFill({
        api: clarityApi,
        fill,
        discovery,
        weeks: { requested: weekIds },
        missingRows: "every-task",
    });
    const { writes } = await executeFillPlan({ api: clarityApi, plan, postNotes: false });

    let success = 0;
    let failed = 0;
    let skipped = 0;
    const resultEntries: FillEntryResult[] = [];

    for (const week of plan.weeks) {
        const timesheetId = week.timesheetId;

        if (week.status !== "ready") {
            resultEntries.push({
                clarityTaskName: `Timesheet #${timesheetId}`,
                clarityTaskCode: "",
                timesheetId,
                timeEntryId: 0,
                totalHours: 0,
                segments: [],
                status: "error",
                error: `Timesheet ${timesheetId} not found`,
            });
            failed++;
            continue;
        }

        for (const entry of week.entries) {
            const base = {
                clarityTaskName: entry.fill.mapping.clarityTaskName,
                clarityTaskCode: entry.fill.mapping.clarityTaskCode,
                timesheetId,
            };

            if (entry.action === "no-row" || !entry.row) {
                resultEntries.push({
                    ...base,
                    timeEntryId: 0,
                    totalHours: 0,
                    segments: [],
                    status: "skipped",
                    error: `No time entry for task in timesheet ${timesheetId}`,
                });
                skipped++;
                continue;
            }

            if (entry.action !== "write") {
                resultEntries.push({
                    ...base,
                    timeEntryId: entry.row.timeEntryId,
                    totalHours: 0,
                    segments: [],
                    status: "skipped",
                    error: SkipReasons[entry.action],
                });
                skipped++;
                continue;
            }

            const outcome = writes.get(entry)!;

            resultEntries.push({
                ...base,
                timeEntryId: entry.row.timeEntryId,
                totalHours: outcome.totalSeconds / 3600,
                segments: entry.segments
                    .filter((s) => s.value > 0)
                    .map((s) => ({ date: s.start.split("T")[0], hours: s.value / 3600 })),
                status: outcome.status,
                ...(outcome.status === "error" ? { error: outcome.error } : {}),
                debug: outcome.debug,
            });

            if (outcome.status === "error") {
                failed++;
            } else {
                success++;
            }
        }
    }

    return { success, failed, skipped, entries: resultEntries };
}
