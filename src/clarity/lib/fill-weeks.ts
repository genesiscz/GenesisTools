import {
    findWeekForDate,
    getTimesheetWeeks,
    hasTimesheetId,
    type IdentifiedTimesheetWeek,
    type TimesheetRecord,
    type TimesheetWeekReader,
} from "@app/clarity/lib/timesheet-weeks";

export interface ResolvedFillWeeks {
    weeks: IdentifiedTimesheetWeek[];
    unresolvedDates: string[];
    /** Clarity user id, needed as the author of a timesheet note. */
    userId?: number;
    /** Timesheets already read during discovery, so the caller need not fetch them again. */
    records: Map<number, TimesheetRecord>;
    /**
     * Open weeks of the requested month that no fill date reached. They are in `weeks` only so a
     * fill can clear requested-month hours Clarity still holds there; with nothing to clear, skip them.
     */
    clearingOnlyWeekIds: Set<number>;
}

/**
 * Resolve the timesheets covering the dates a fill touches. Periods are discovered per run through
 * the shared carousel walk; nothing has to be stored on a mapping first.
 */
export async function resolveFillWeeks({
    api,
    dates,
    month,
    year,
    includeMonthWeeks = false,
}: {
    api: TimesheetWeekReader;
    dates: string[];
    month?: number;
    year?: number;
    /** Also return every open week overlapping month/year, so a month replacement can clear them. */
    includeMonthWeeks?: boolean;
}): Promise<ResolvedFillWeeks> {
    const { weeks: available, userId, records } = await getTimesheetWeeks(api, month, year);

    const weeks: IdentifiedTimesheetWeek[] = [];
    const unresolvedDates: string[] = [];

    for (const date of dates) {
        const week = findWeekForDate(available, date);

        if (!week) {
            unresolvedDates.push(date);
            continue;
        }

        if (!weeks.some((known) => known.timesheetId === week.timesheetId)) {
            weeks.push(week);
        }
    }

    // Every open week overlapping the month is part of a month replacement, not only the weeks
    // that carry ADO entries: stale hours in an empty week must be reachable to be cleared.
    const clearingOnlyWeekIds = new Set<number>();
    if (includeMonthWeeks && month !== undefined && year !== undefined) {
        const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
        const monthEnd = `${year}-${String(month).padStart(2, "0")}-31`;

        for (const week of available) {
            const overlaps = week.startDate.slice(0, 10) <= monthEnd && week.finishDate.slice(0, 10) >= monthStart;
            if (!overlaps || !hasTimesheetId(week)) {
                continue;
            }

            if (!weeks.some((known) => known.timesheetId === week.timesheetId)) {
                weeks.push(week);
                clearingOnlyWeekIds.add(week.timesheetId);
            }
        }
    }

    return { weeks, unresolvedDates, userId, records, clearingOnlyWeekIds };
}
