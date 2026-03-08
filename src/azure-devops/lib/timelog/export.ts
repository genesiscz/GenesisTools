import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { TimeLogQueryEntry } from "@app/azure-devops/types";

export interface ExportedEntry extends TimeLogQueryEntry {
    workItemTitle: string;
    workItemType: string;
    teamProject: string;
}

export interface DaySummary {
    /** date string YYYY-MM-DD */
    [date: string]: number;
}

export interface WorkItemSummary {
    minutes: number;
    title: string;
    count: number;
}

export interface ProjectSummary {
    minutes: number;
    count: number;
}

export interface MonthExport {
    month: number;
    year: number;
    fromDate: string;
    toDate: string;
    entries: ExportedEntry[];
    summary: {
        totalMinutes: number;
        totalHours: number;
        entriesByProject: Record<string, ProjectSummary>;
        entriesByWorkItem: Record<number, WorkItemSummary>;
        entriesByDay: Record<string, number>;
    };
}

/**
 * Get the first and last day of a given month as YYYY-MM-DD strings.
 */
function getMonthRange(month: number, year: number): { fromDate: string; toDate: string } {
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0); // last day of month

    const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    return { fromDate: fmt(from), toDate: fmt(to) };
}

/**
 * Normalize date format: "2026-01-30T00:00:00" -> "2026-01-30"
 */
function normalizeDate(date: string): string {
    if (date.includes("T")) {
        return date.split("T")[0];
    }
    return date;
}

/**
 * Export all timelog entries for a given month with summary aggregations.
 *
 * @param api - TimeLogApi instance
 * @param month - Month number (1-12)
 * @param year - Year (e.g. 2026)
 * @param userId - Azure AD user GUID
 * @param options - Optional settings
 * @returns Structured month export with entries and summary
 */
export async function exportMonth(
    api: TimeLogApi,
    month: number,
    year: number,
    userId: string,
    _options?: { enrichWorkItems?: boolean }
): Promise<MonthExport> {
    const { fromDate, toDate } = getMonthRange(month, year);

    // Query all timelog entries for the month
    const rawEntries = await api.queryTimeLogs({
        FromDate: fromDate,
        ToDate: toDate,
        userId,
    });

    // Convert to ExportedEntry (work item enrichment fields left empty for now)
    const entries: ExportedEntry[] = rawEntries.map((e) => ({
        ...e,
        date: normalizeDate(e.date),
        workItemTitle: "",
        workItemType: "",
        teamProject: "",
    }));

    // Build summary aggregations
    const entriesByProject: Record<string, ProjectSummary> = {};
    const entriesByWorkItem: Record<number, WorkItemSummary> = {};
    const entriesByDay: Record<string, number> = {};
    let totalMinutes = 0;

    for (const entry of entries) {
        totalMinutes += entry.minutes;

        // By project
        const projectKey = entry.projectId;

        if (!entriesByProject[projectKey]) {
            entriesByProject[projectKey] = { minutes: 0, count: 0 };
        }
        entriesByProject[projectKey].minutes += entry.minutes;
        entriesByProject[projectKey].count += 1;

        // By work item
        if (!entriesByWorkItem[entry.workItemId]) {
            entriesByWorkItem[entry.workItemId] = {
                minutes: 0,
                title: entry.workItemTitle || `#${entry.workItemId}`,
                count: 0,
            };
        }
        entriesByWorkItem[entry.workItemId].minutes += entry.minutes;
        entriesByWorkItem[entry.workItemId].count += 1;

        // By day
        const day = entry.date;
        entriesByDay[day] = (entriesByDay[day] || 0) + entry.minutes;
    }

    return {
        month,
        year,
        fromDate,
        toDate,
        entries,
        summary: {
            totalMinutes,
            totalHours: Math.round((totalMinutes / 60) * 100) / 100,
            entriesByProject,
            entriesByWorkItem,
            entriesByDay,
        },
    };
}
