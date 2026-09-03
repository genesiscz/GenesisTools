import type { ClarityMapping } from "@app/clarity/config";
import { findWeekForDate, getTimesheetWeeks, type TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityApi } from "@genesiscz/utils/clarity";

export interface ResolvedFillWeeks {
    weeks: TimesheetWeek[];
    unresolvedDates: string[];
    /** Clarity user id, needed as the author of a timesheet note. */
    userId?: number;
}

/**
 * Resolve the timesheets covering the dates a fill touches. Discovery runs through the shared
 * carousel walk, so a mapping without a cached timesheet id is not a precondition.
 */
export async function resolveFillWeeks({
    api,
    mappings,
    dates,
    month,
    year,
}: {
    api: ClarityApi;
    mappings: ClarityMapping[];
    dates: string[];
    month?: number;
    year?: number;
}): Promise<ResolvedFillWeeks> {
    const { weeks: available, userId } = await getTimesheetWeeks(api, mappings, month, year);

    const weeks: TimesheetWeek[] = [];
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

    return { weeks, unresolvedDates, userId };
}
