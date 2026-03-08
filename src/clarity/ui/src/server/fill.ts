import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { type ClarityMapping, getMappingForWorkItem, requireConfig } from "@app/clarity/config";
import { getTimesheetWeeks } from "@app/clarity/lib/timesheet-weeks";
import type { TimeEntryRecord, TimeSegment, TimeSeriesValue } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";
import { formatDate } from "@app/utils/date";

interface FillEntry {
    mapping: ClarityMapping;
    dayMinutes: Record<string, number>;
    totalMinutes: number;
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
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
}

export interface FillPreviewResult {
    weeks: WeekPreview[];
    totalMapped: number;
    totalUnmapped: number;
    diagnostics?: {
        reason: string;
        message: string;
    };
}

export async function getFillPreview(month: number, year: number): Promise<FillPreviewResult> {
    const clarityConfig = await requireConfig();
    const adoConfig = loadAdoConfig() as AzureConfigWithTimeLog | null;

    if (!adoConfig?.orgId || !adoConfig.timelog?.functionsKey) {
        throw new Error("Azure DevOps / TimeLog not configured. Run: tools azure-devops configure");
    }

    const adoUser = adoConfig.timelog.defaultUser;

    if (!adoUser) {
        throw new Error("TimeLog user not configured in Azure DevOps config");
    }

    const adoApi = new TimeLogApi(adoConfig.orgId, adoConfig.projectId, adoConfig.timelog.functionsKey, adoUser);
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
        cookies: clarityConfig.cookies,
    });

    const adoExport = await exportMonth(adoApi, month, year, adoUser.userId);
    const fillMap = new Map<number, FillEntry>();
    const unmappedByWi = new Map<number, number>();

    for (const entry of adoExport.entries) {
        const mapping = getMappingForWorkItem(clarityConfig.mappings, entry.workItemId);

        if (!mapping) {
            unmappedByWi.set(entry.workItemId, (unmappedByWi.get(entry.workItemId) ?? 0) + entry.minutes);
            continue;
        }

        let fill = fillMap.get(mapping.clarityTaskId);

        if (!fill) {
            fill = { mapping, dayMinutes: {}, totalMinutes: 0 };
            fillMap.set(mapping.clarityTaskId, fill);
        }

        fill.dayMinutes[entry.date] = (fill.dayMinutes[entry.date] ?? 0) + entry.minutes;
        fill.totalMinutes += entry.minutes;
    }

    const totalMapped = [...fillMap.values()].reduce((s, f) => s + f.totalMinutes, 0);
    const totalUnmapped = [...unmappedByWi.values()].reduce((s, v) => s + v, 0);

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

    // Resolve Clarity timesheet weeks for this month via the carousel API
    const { weeks: clarityWeeks } = await getTimesheetWeeks(clarityApi, clarityConfig.mappings, month, year);

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
        // Filter fill entries to only include days within this week's range
        const weekEntries: WeekPreview["entries"] = [];

        for (const fill of fillMap.values()) {
            const weekDayValues: Record<string, number> = {};
            let weekTotal = 0;

            for (const [date, mins] of Object.entries(fill.dayMinutes)) {
                if (date >= cw.startDate && date <= cw.finishDate) {
                    weekDayValues[date] = mins;
                    weekTotal += mins;
                }
            }

            if (weekTotal > 0) {
                weekEntries.push({
                    clarityTaskName: fill.mapping.clarityTaskName,
                    clarityTaskCode: fill.mapping.clarityTaskCode,
                    dayValues: weekDayValues,
                    totalMinutes: weekTotal,
                });
            }
        }

        // Only include weeks that have data
        if (weekEntries.length === 0) {
            continue;
        }

        // Filter unmapped work items to this week's range too
        const weekUnmapped: WeekPreview["unmappedWorkItems"] = [...unmappedByWi.entries()].map(
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

    return {
        weeks: weekPreviews,
        totalMapped: [...fillMap.values()].reduce((s, f) => s + f.totalMinutes, 0),
        totalUnmapped: [...unmappedByWi.values()].reduce((s, v) => s + v, 0),
    };
}

function minutesToSeconds(minutes: number): number {
    return minutes * 60;
}

export async function executeFill(
    month: number,
    year: number,
    weekIds: number[]
): Promise<{ success: number; failed: number; errors: string[] }> {
    const clarityConfig = await requireConfig();
    const adoConfig = loadAdoConfig() as AzureConfigWithTimeLog | null;

    if (!adoConfig?.orgId || !adoConfig.timelog?.functionsKey) {
        throw new Error("Azure DevOps / TimeLog not configured. Run: tools azure-devops configure");
    }

    const adoUser = adoConfig.timelog.defaultUser;

    if (!adoUser) {
        throw new Error("TimeLog user not configured in Azure DevOps config");
    }

    const adoApi = new TimeLogApi(adoConfig.orgId, adoConfig.projectId, adoConfig.timelog.functionsKey, adoUser);
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
        cookies: clarityConfig.cookies,
    });

    const adoExport = await exportMonth(adoApi, month, year, adoUser.userId);
    const fillMap = new Map<number, FillEntry>();

    for (const entry of adoExport.entries) {
        const mapping = getMappingForWorkItem(clarityConfig.mappings, entry.workItemId);

        if (!mapping) {
            continue;
        }

        let fill = fillMap.get(mapping.clarityTaskId);

        if (!fill) {
            fill = { mapping, dayMinutes: {}, totalMinutes: 0 };
            fillMap.set(mapping.clarityTaskId, fill);
        }

        fill.dayMinutes[entry.date] = (fill.dayMinutes[entry.date] ?? 0) + entry.minutes;
        fill.totalMinutes += entry.minutes;
    }

    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const timesheetId of weekIds) {
        const tsData = await clarityApi.getTimesheet(timesheetId);
        const ts = tsData.timesheets._results[0];

        if (!ts) {
            errors.push(`Timesheet ${timesheetId} not found`);
            failed++;
            continue;
        }

        for (const fill of fillMap.values()) {
            const timeEntry = ts.timeentries._results.find(
                (e: TimeEntryRecord) => e.taskId === fill.mapping.clarityTaskId
            );

            if (!timeEntry) {
                continue;
            }

            const segments: TimeSegment[] = [];
            const periodStart = new Date(ts.timePeriodStart);

            for (let d = 0; d < 7; d++) {
                const date = new Date(periodStart);
                date.setDate(date.getDate() + d);
                const dateStr = formatDate(date);
                const mins = fill.dayMinutes[dateStr];

                if (mins && mins > 0) {
                    const iso = `${dateStr}T00:00:00`;
                    segments.push({ start: iso, finish: iso, value: minutesToSeconds(mins) });
                }
            }

            const totalSeconds = segments.reduce((sum, s) => sum + s.value, 0);
            const actuals: TimeSeriesValue = {
                isFiscal: false,
                curveType: "value",
                total: totalSeconds,
                dataType: "numeric",
                _type: "tsv",
                start: ts.timePeriodStart,
                finish: ts.timePeriodFinish,
                segmentList: { total: totalSeconds, defaultValue: 0, segments },
            };

            try {
                await clarityApi.updateTimeEntry(timesheetId, timeEntry._internalId, {
                    taskId: timeEntry.taskId,
                    actuals,
                });
                success++;
            } catch (err) {
                failed++;
                errors.push(`${fill.mapping.clarityTaskName}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    return { success, failed, errors };
}
