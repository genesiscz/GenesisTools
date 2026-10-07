import type { ClarityMapping } from "@app/clarity/config";
import { getMappingForWorkItem } from "@app/clarity/config";
import type { ApiDebugInfo, TimeSegment } from "@genesiscz/utils/clarity";
import { buildDailyValues, isDateInHalfOpenRange, minutesToSeconds } from "@genesiscz/utils/date";

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

/**
 * Fill minutes that fall inside one timesheet period. Zero means ADO has nothing for this task
 * there; the week is then written only to clear requested-month actuals Clarity still holds
 * (see requestedMonthActualSeconds), never because of adjacent-month data.
 */
export function fillMinutesInPeriod(
    dayMinutes: Record<string, number>,
    periodStart: string,
    periodFinishExclusive: string
): number {
    return Object.entries(dayMinutes)
        .filter(([date]) => isDateInHalfOpenRange(date, periodStart, periodFinishExclusive))
        .reduce((sum, [, minutes]) => sum + minutes, 0);
}

/** Seconds this row already holds on days of the requested month: what a zero-minute week must clear. */
export function requestedMonthActualSeconds(
    segments: TimeSegment[] | undefined,
    options: { year: number; month: number }
): number {
    const requestedMonth = `${options.year}-${String(options.month).padStart(2, "0")}-`;

    return (segments ?? [])
        .filter((segment) => segment.start.startsWith(requestedMonth))
        .reduce((sum, segment) => sum + segment.value, 0);
}

/** True when the replacement would change any day's value: an unchanged week is not written. */
export function replacementChangesActuals(segments: TimeSegment[], existing: TimeSegment[] | undefined): boolean {
    const perDay = (list: TimeSegment[]) => {
        const days = new Map<string, number>();
        for (const segment of list) {
            const date = segment.start.split("T")[0];
            days.set(date, (days.get(date) ?? 0) + segment.value);
        }
        return days;
    };
    const before = perDay(existing ?? []);
    const after = perDay(segments);

    for (const date of new Set([...before.keys(), ...after.keys()])) {
        if ((before.get(date) ?? 0) !== (after.get(date) ?? 0)) {
            return true;
        }
    }

    return false;
}

/**
 * Build a complete Clarity period replacement for one requested month.
 * Days inside the month come from the fill (missing means an intentional zero),
 * while adjacent-month days in a straddling week retain their current actuals.
 */
export function buildMonthAwareTimeSegments(options: {
    periodStart: string;
    periodFinishExclusive: string;
    year: number;
    month: number;
    dayMinutes: Record<string, number>;
    existingSegments?: TimeSegment[];
}): TimeSegment[] {
    const existingMinutes: Record<string, number> = {};

    for (const segment of options.existingSegments ?? []) {
        const date = segment.start.split("T")[0];
        existingMinutes[date] = (existingMinutes[date] ?? 0) + segment.value / 60;
    }

    const requestedMonth = `${options.year}-${String(options.month).padStart(2, "0")}`;
    const mergedMinutes = { ...existingMinutes };

    for (const day of buildDailyValues(options.periodStart, options.periodFinishExclusive, (date) => date)) {
        if (day.date.startsWith(`${requestedMonth}-`)) {
            mergedMinutes[day.date] = options.dayMinutes[day.date] ?? 0;
        }
    }

    return buildTimeSegments(options.periodStart, options.periodFinishExclusive, mergedMinutes);
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
