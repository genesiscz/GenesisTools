import type { ClarityMapping } from "@app/clarity/config";
import type { ClarityApi } from "@app/utils/clarity";

export interface TimesheetWeek {
    timesheetId: number;
    timePeriodId: number;
    startDate: string;
    finishDate: string;
    totalHours: number;
    status: string;
}

export async function getTimesheetWeeks(
    api: ClarityApi,
    mappings: ClarityMapping[],
    month?: number,
    year?: number
): Promise<{ weeks: TimesheetWeek[] }> {
    // Try to find a valid timePeriodId to seed the carousel
    const timePeriodId = await findValidTimePeriodId(api, mappings);

    const app = await api.getTimesheetApp(timePeriodId);
    let carousel = app.tscarousel?._results;

    // If carousel is empty, try extracting timePeriodId from the timesheets section
    if (!carousel?.length) {
        const ts = app.timesheets?._results?.[0];

        if (ts?.timePeriodId) {
            const retry = await api.getTimesheetApp(ts.timePeriodId);
            carousel = retry.tscarousel?._results;
        }
    }

    if (!carousel?.length) {
        return { weeks: [] };
    }

    let weeks: TimesheetWeek[] = carousel.map((entry) => ({
        timesheetId: entry.timesheet_id,
        timePeriodId: entry.id,
        startDate: entry.start_date.split("T")[0],
        finishDate: entry.finish_date.split("T")[0],
        totalHours: entry.total,
        status: entry.prstatus?.displayValue ?? "unknown",
    }));

    // Filter to weeks that overlap the requested month/year
    if (month !== undefined && year !== undefined) {
        const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

        weeks = weeks.filter((w) => w.startDate <= monthEnd && w.finishDate >= monthStart);
    }

    return { weeks };
}

async function findValidTimePeriodId(api: ClarityApi, mappings: ClarityMapping[]): Promise<number> {
    // Strategy 1: Use an existing mapping's clarityTimesheetId to get a timePeriodId
    for (const mapping of mappings) {
        if (!mapping.clarityTimesheetId) {
            continue;
        }

        try {
            const ts = await api.getTimesheet(mapping.clarityTimesheetId);
            const record = ts.timesheets._results[0];

            if (record?.timePeriodId) {
                return record.timePeriodId;
            }
        } catch {
            // Timesheet might no longer exist, try next
        }
    }

    // Strategy 2: Fall back to 0 (current period) and hope the response has data
    return 0;
}
