import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { requireConfig } from "@app/clarity/config";
import {
    buildFillMap,
    buildTimeSegments,
    type ExecuteFillResult,
    type FillEntryResult,
} from "@app/clarity/lib/fill-utils";
import { getTimesheetWeeks } from "@app/clarity/lib/timesheet-weeks";
import type { ApiDebugInfo, TimeEntryRecord, TimeSeriesValue } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";
import { addDay } from "@app/utils/date";

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
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
    clarityTotalMinutes?: number;
    hasNotes?: boolean;
    numberOfNotes?: number;
}

function requireAdoTimeLogConfig(): { config: AzureConfigWithTimeLog; user: TimeLogUser; api: TimeLogApi } {
    const config = loadAdoConfig() as AzureConfigWithTimeLog | null;

    if (!config) {
        throw new Error("Azure DevOps is not configured. Open Settings and complete the Azure DevOps section.");
    }

    if (!config.orgId) {
        throw new Error("Organization ID missing from config. Open Settings and reconnect Azure DevOps.");
    }

    if (!config.projectId) {
        throw new Error("Project ID missing from config. Open Settings and reconnect Azure DevOps.");
    }

    if (!config.timelog?.functionsKey) {
        throw new Error("TimeLog API key is missing. Open Settings and complete the TimeLog section.");
    }

    const user = config.timelog.defaultUser;

    if (!user) {
        throw new Error("TimeLog user is missing. Open Settings and choose a TimeLog team member.");
    }

    const api = new TimeLogApi(config.orgId, config.projectId, config.timelog.functionsKey, user);
    return { config, user, api };
}

export interface FillPreviewResult {
    weeks: WeekPreview[];
    totalMapped: number;
    totalUnmapped: number;
    adoConfig?: { org: string; project: string };
    userId?: number;
    diagnostics?: {
        reason: string;
        message: string;
    };
}

export async function getFillPreview(month: number, year: number): Promise<FillPreviewResult> {
    const clarityConfig = await requireConfig();
    const { config: adoConfig, user: adoUser, api: adoApi } = requireAdoTimeLogConfig();
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
        cookies: clarityConfig.cookies,
    });

    const adoExport = await exportMonth(adoApi, month, year, adoUser.userId);

    // Enrich work item titles/types from ADO
    const uniqueIds = [...new Set(adoExport.entries.map((e) => e.workItemId))];

    if (uniqueIds.length > 0) {
        try {
            const workItems = await enrichWorkItems(adoConfig, uniqueIds);

            for (const entry of adoExport.entries) {
                const wi = workItems.get(entry.workItemId);

                if (wi) {
                    entry.workItemTitle = wi.title;
                    entry.workItemType = wi.type ?? "";
                }
            }
        } catch {
            // Non-fatal — titles will show as "#ID"
        }
    }

    const { fillMap, unmappedByWi, unmappedEntries } = buildFillMap(adoExport.entries, clarityConfig.mappings, {
        trackEntries: true,
    });

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

    const { weeks: clarityWeeks, userId } = await getTimesheetWeeks(clarityApi, clarityConfig.mappings, month, year);

    if (clarityWeeks.length === 0) {
        return {
            weeks: [],
            totalMapped,
            totalUnmapped,
            diagnostics: {
                reason: "no_timesheet_weeks",
                message:
                    "Could not resolve Clarity timesheet weeks for this month. Check that mappings have a valid clarityTimesheetId.",
            },
        };
    }

    const weekPreviews: WeekPreview[] = [];

    for (const cw of clarityWeeks) {
        const weekEntries: WeekPreview["entries"] = [];

        for (const fill of fillMap.values()) {
            const weekDayValues: Record<string, number> = {};
            let weekTotal = 0;

            for (const [date, mins] of Object.entries(fill.dayMinutes)) {
                if (date >= cw.startDate && date < cw.finishDate) {
                    weekDayValues[date] = mins;
                    weekTotal += mins;
                }
            }

            if (weekTotal > 0) {
                const weekTimelogs = (fill.timelogEntries ?? []).filter(
                    (e) => e.date >= cw.startDate && e.date < cw.finishDate
                );

                weekEntries.push({
                    clarityTaskName: fill.mapping.clarityTaskName,
                    clarityTaskCode: fill.mapping.clarityTaskCode,
                    dayValues: weekDayValues,
                    totalMinutes: weekTotal,
                    timelogEntries: weekTimelogs,
                });
            }
        }

        // Filter unmapped entries to this week's date range, then aggregate per work item
        const weekUnmappedMap = new Map<number, number>();

        for (const ue of unmappedEntries) {
            if (ue.date >= cw.startDate && ue.date < cw.finishDate) {
                weekUnmappedMap.set(ue.workItemId, (weekUnmappedMap.get(ue.workItemId) ?? 0) + ue.minutes);
            }
        }

        const weekUnmapped: WeekPreview["unmappedWorkItems"] = [...weekUnmappedMap.entries()].map(
            ([workItemId, minutes]) => ({ workItemId, minutes })
        );

        weekPreviews.push({
            timesheetId: cw.timesheetId,
            periodStart: cw.startDate,
            periodFinish: cw.finishDate,
            entries: weekEntries,
            unmappedWorkItems: weekUnmapped,
        });
    }

    // Fetch current Clarity state for each week (parallel)
    await Promise.all(
        weekPreviews.map(async (wp) => {
            try {
                const tsData = await clarityApi.getTimesheet(wp.timesheetId);
                const ts = tsData.timesheets._results[0];

                if (!ts) {
                    return;
                }

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
        totalMapped: [...fillMap.values()].reduce((s, f) => s + f.totalMinutes, 0),
        totalUnmapped: [...unmappedByWi.values()].reduce((s, v) => s + v, 0),
        adoConfig: adoInfo,
        userId,
    };
}

export async function postTimesheetNote(timesheetId: number, noteText: string, userId: number): Promise<void> {
    const clarityConfig = await requireConfig();
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
        cookies: clarityConfig.cookies,
    });

    await clarityApi.createTimesheetNote(timesheetId, noteText, userId);
}

export async function executeFill(month: number, year: number, weekIds: number[]): Promise<ExecuteFillResult> {
    const clarityConfig = await requireConfig();
    const { user: adoUser, api: adoApi } = requireAdoTimeLogConfig();
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
        cookies: clarityConfig.cookies,
    });

    const adoExport = await exportMonth(adoApi, month, year, adoUser.userId);
    const { fillMap } = buildFillMap(adoExport.entries, clarityConfig.mappings);

    let success = 0;
    let failed = 0;
    let skipped = 0;
    const resultEntries: FillEntryResult[] = [];

    for (const timesheetId of weekIds) {
        const tsData = await clarityApi.getTimesheet(timesheetId);
        const ts = tsData.timesheets._results[0];

        if (!ts) {
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

        for (const fill of fillMap.values()) {
            const timeEntry = ts.timeentries._results.find(
                (e: TimeEntryRecord) => e.taskId === fill.mapping.clarityTaskId
            );

            if (!timeEntry) {
                resultEntries.push({
                    clarityTaskName: fill.mapping.clarityTaskName,
                    clarityTaskCode: fill.mapping.clarityTaskCode,
                    timesheetId,
                    timeEntryId: 0,
                    totalHours: 0,
                    segments: [],
                    status: "skipped",
                    error: `No time entry for task in timesheet ${timesheetId}`,
                });
                skipped++;
                continue;
            }

            // timePeriodFinish is inclusive (last day e.g. Sunday "2026-02-08T00:00:00")
            // buildTimeSegments needs exclusive end for its loop
            const exclusiveEnd = `${addDay(ts.timePeriodFinish.split("T")[0])}T00:00:00`;
            const segments = buildTimeSegments(ts.timePeriodStart, exclusiveEnd, fill.dayMinutes);
            const totalSeconds = segments.reduce((sum, s) => sum + s.value, 0);

            // Skip zero-minute updates to avoid wiping existing Clarity entries
            if (totalSeconds === 0) {
                resultEntries.push({
                    clarityTaskName: fill.mapping.clarityTaskName,
                    clarityTaskCode: fill.mapping.clarityTaskCode,
                    timesheetId,
                    timeEntryId: timeEntry._internalId,
                    totalHours: 0,
                    segments: [],
                    status: "skipped",
                    error: "No minutes for this task in this week",
                });
                skipped++;
                continue;
            }

            const actuals: TimeSeriesValue = {
                isFiscal: false,
                curveType: "value",
                dataType: "numeric",
                _type: "tsv",
                start: ts.timePeriodStart,
                finish: ts.timePeriodFinish,
                segmentList: {
                    total: totalSeconds,
                    defaultValue: 0,
                    segments,
                },
            };

            const entryResult: FillEntryResult = {
                clarityTaskName: fill.mapping.clarityTaskName,
                clarityTaskCode: fill.mapping.clarityTaskCode,
                timesheetId,
                timeEntryId: timeEntry._internalId,
                totalHours: totalSeconds / 3600,
                segments: segments
                    .filter((s) => s.value > 0)
                    .map((s) => ({ date: s.start.split("T")[0], hours: s.value / 3600 })),
                status: "success",
            };

            try {
                const { debug } = await clarityApi.updateTimeEntryVerbose(timesheetId, timeEntry._internalId, {
                    taskId: timeEntry.taskId,
                    actuals,
                });
                entryResult.debug = debug;
                success++;
            } catch (err) {
                entryResult.status = "error";
                entryResult.error = err instanceof Error ? err.message : String(err);
                entryResult.debug = (err as Error & { debug?: ApiDebugInfo }).debug;
                failed++;
            }

            resultEntries.push(entryResult);
        }
    }

    return { success, failed, skipped, entries: resultEntries };
}
