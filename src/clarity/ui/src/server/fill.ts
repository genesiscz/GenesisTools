import { exportMonth } from "../../../../azure-devops/lib/timelog/export";
import { TimeLogApi } from "../../../../azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "../../../../azure-devops/utils";
import type { TimeEntryRecord, TimeSegment, TimeSeriesValue } from "../../../../utils/clarity";
import { ClarityApi } from "../../../../utils/clarity";
import { getMappingForWorkItem, requireConfig, type ClarityMapping } from "../../../config";

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
}

function formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getWeekRange(date: Date): { start: Date; end: Date } {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const start = new Date(d);
    start.setDate(diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
}

export async function getFillPreview(month: number, year: number): Promise<FillPreviewResult> {
    const clarityConfig = await requireConfig();
    const adoConfig = requireTimeLogConfig();
    const adoUser = requireTimeLogUser(adoConfig);
    const adoApi = new TimeLogApi(adoConfig.orgId!, adoConfig.projectId, adoConfig.timelog!.functionsKey, adoUser);
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
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

    const allDates = Object.keys(
        [...fillMap.values()].reduce((acc, f) => ({ ...acc, ...f.dayMinutes }), {} as Record<string, number>)
    ).sort();

    const weeksSeen = new Set<string>();
    const weeks: Array<{ start: Date; end: Date }> = [];

    for (const date of allDates) {
        const d = new Date(date);
        const { start } = getWeekRange(d);
        const key = formatDate(start);

        if (!weeksSeen.has(key)) {
            weeksSeen.add(key);
            weeks.push(getWeekRange(d));
        }
    }

    const firstMapping = clarityConfig.mappings[0];

    if (!firstMapping?.clarityTimesheetId) {
        return {
            weeks: [],
            totalMapped: [...fillMap.values()].reduce((s, f) => s + f.totalMinutes, 0),
            totalUnmapped: [...unmappedByWi.values()].reduce((s, v) => s + v, 0),
        };
    }

    const weekPreviews: WeekPreview[] = [];

    for (const _week of weeks) {
        const tsData = await clarityApi.getTimesheet(firstMapping.clarityTimesheetId);
        const ts = tsData.timesheets._results[0];

        if (!ts) {
            continue;
        }

        const preview: WeekPreview = {
            timesheetId: ts._internalId,
            periodStart: ts.timePeriodStart,
            periodFinish: ts.timePeriodFinish,
            entries: [],
            unmappedWorkItems: [...unmappedByWi.entries()].map(([workItemId, minutes]) => ({
                workItemId,
                minutes,
            })),
        };

        for (const fill of fillMap.values()) {
            preview.entries.push({
                clarityTaskName: fill.mapping.clarityTaskName,
                clarityTaskCode: fill.mapping.clarityTaskCode,
                dayValues: fill.dayMinutes,
                totalMinutes: fill.totalMinutes,
            });
        }

        weekPreviews.push(preview);
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
    const adoConfig = requireTimeLogConfig();
    const adoUser = requireTimeLogUser(adoConfig);
    const adoApi = new TimeLogApi(adoConfig.orgId!, adoConfig.projectId, adoConfig.timelog!.functionsKey, adoUser);
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
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
                errors.push(
                    `${fill.mapping.clarityTaskName}: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
    }

    return { success, failed, errors };
}
