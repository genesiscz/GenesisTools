import {
    findWeekForDate,
    getTimesheetWeeks,
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
}: {
    api: TimesheetWeekReader;
    dates: string[];
    month?: number;
    year?: number;
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

    return { weeks, unresolvedDates, userId, records };
}
