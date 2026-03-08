import type { ClarityMapping } from "@app/clarity/config";
import { getMappingForWorkItem } from "@app/clarity/config";
import type { ApiDebugInfo, TimeSegment } from "@app/utils/clarity";
import { buildDailyValues, minutesToSeconds } from "@app/utils/date";

// -- Shared types --

export interface FillEntry {
    mapping: ClarityMapping;
    dayMinutes: Record<string, number>;
    totalMinutes: number;
    timelogEntries?: TimelogEntry[];
}

export interface TimelogEntry {
    workItemId: number;
    workItemTitle: string;
    workItemType: string;
    timeTypeDescription: string;
    comment: string | null;
    date: string;
    minutes: number;
}

export interface FillEntryResult {
    clarityTaskName: string;
    clarityTaskCode: string;
    timesheetId: number;
    timeEntryId: number;
    totalHours: number;
    segments: Array<{ date: string; hours: number }>;
    status: "success" | "error" | "skipped";
    error?: string;
    debug?: ApiDebugInfo;
}

export interface ExecuteFillResult {
    success: number;
    failed: number;
    skipped: number;
    entries: FillEntryResult[];
}

// -- Shared logic --

/**
 * Build Clarity-format time segments for all days in a period.
 * Includes every day (even zero-value) to match real Clarity behavior.
 */
export function buildTimeSegments(
    periodStart: string,
    periodFinish: string,
    dayMinutes: Record<string, number>
): TimeSegment[] {
    return buildDailyValues(periodStart, periodFinish, (date) => dayMinutes[date] ?? 0).map((d) => ({
        start: d.iso,
        finish: d.iso,
        value: minutesToSeconds(d.value),
    }));
}

interface AdoEntry {
    workItemId: number;
    workItemTitle?: string;
    workItemType?: string;
    timeTypeDescription?: string;
    comment?: string | null;
    date: string;
    minutes: number;
}

/** Per-date unmapped entry for a single work item */
export interface UnmappedEntry {
    workItemId: number;
    date: string;
    minutes: number;
}

/**
 * Group ADO timelog entries by Clarity mapping → FillEntry map.
 * Returns both the fill map and a map of unmapped work items.
 */
export function buildFillMap(
    entries: AdoEntry[],
    mappings: ClarityMapping[],
    options?: { trackEntries?: boolean }
): { fillMap: Map<number, FillEntry>; unmappedByWi: Map<number, number>; unmappedEntries: UnmappedEntry[] } {
    const fillMap = new Map<number, FillEntry>();
    const unmappedByWi = new Map<number, number>();
    const unmappedEntries: UnmappedEntry[] = [];
    const trackEntries = options?.trackEntries ?? false;

    for (const entry of entries) {
        const mapping = getMappingForWorkItem(mappings, entry.workItemId);

        if (!mapping) {
            unmappedByWi.set(entry.workItemId, (unmappedByWi.get(entry.workItemId) ?? 0) + entry.minutes);
            unmappedEntries.push({ workItemId: entry.workItemId, date: entry.date, minutes: entry.minutes });
            continue;
        }

        let fill = fillMap.get(mapping.clarityTaskId);

        if (!fill) {
            fill = { mapping, dayMinutes: {}, totalMinutes: 0, ...(trackEntries ? { timelogEntries: [] } : {}) };
            fillMap.set(mapping.clarityTaskId, fill);
        }

        fill.dayMinutes[entry.date] = (fill.dayMinutes[entry.date] ?? 0) + entry.minutes;
        fill.totalMinutes += entry.minutes;

        if (trackEntries && fill.timelogEntries) {
            fill.timelogEntries.push({
                workItemId: entry.workItemId,
                workItemTitle: entry.workItemTitle || `#${entry.workItemId}`,
                workItemType: entry.workItemType || "",
                timeTypeDescription: entry.timeTypeDescription || "",
                comment: entry.comment ?? null,
                date: entry.date,
                minutes: entry.minutes,
            });
        }
    }

    return { fillMap, unmappedByWi, unmappedEntries };
}
