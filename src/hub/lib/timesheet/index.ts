import { createHash } from "node:crypto";
import type { FillResult, MonthFillInput, MonthFillPreview, ShownFillWeek } from "@app/clarity/lib/month-fill";
import type {
    TimesheetFillInput,
    TimesheetFillReceiptDto,
    TimesheetRowDto,
    TimesheetWeekDto,
} from "@app/dev-dashboard/contract/timesheet";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The Friday timesheet swipe (F27): the week of a date as the Clarity month fill plans it, and its fill. The phone,
 * the dashboard and `tools clarity fill` all render the one plan of `src/clarity/lib/month-fill.ts`, so the rows the
 * phone shows are the rows the fill writes. The fill names the revision the phone showed and is refused when the
 * week read again no longer matches it.
 */

export interface TimesheetDeps {
    preview?: (input: MonthFillInput) => Promise<MonthFillPreview>;
    execute?: (input: MonthFillInput) => Promise<FillResult>;
}

async function liveDeps() {
    const [monthFill, { dashboardFillDeps }] = await Promise.all([
        import("@app/clarity/lib/month-fill"),
        import("@app/clarity/ui/src/server/fill"),
    ]);

    return { monthFill, dashboardFillDeps };
}

async function livePreview(input: MonthFillInput): Promise<MonthFillPreview> {
    const { monthFill, dashboardFillDeps } = await liveDeps();
    return monthFill.previewMonthFill(input, dashboardFillDeps({ titles: true }).deps);
}

async function liveExecute(input: MonthFillInput): Promise<FillResult> {
    const { monthFill, dashboardFillDeps } = await liveDeps();
    return monthFill.executeMonthFill(input, dashboardFillDeps().deps);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The week of a day is planned in the month its period starts in; a week can start in the month before. */
function monthsToRead(date: string): Array<{ month: number; year: number }> {
    const [year, month] = date.split("-").map(Number);
    const previous = month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
    return [{ month, year }, previous];
}

async function rowsOf(week: ShownFillWeek): Promise<TimesheetRowDto[]> {
    const { weekRows } = await import("@app/clarity/lib/month-fill");

    return weekRows(week).map((row) => ({
        task: row.taskName,
        code: row.taskCode,
        minutesByDay: row.minutesByDay,
        totalMinutes: row.totalMinutes,
        clarityMinutes: row.clarityMinutes,
        items: row.timelogEntries.map((item) => ({
            workItemId: item.workItemId,
            title: item.workItemTitle,
            minutes: item.minutes,
        })),
    }));
}

export function weekRevision(rows: readonly TimesheetRowDto[]): string {
    const shape = rows.map((row) => [row.code, row.minutesByDay]);
    return createHash("sha256").update(SafeJSON.stringify(shape)).digest("hex").slice(0, 16);
}

async function findWeek(
    date: string,
    deps: TimesheetDeps
): Promise<{ week: TimesheetWeekDto; month: number; year: number } | null> {
    if (!DATE.test(date)) {
        throw new Error("date: YYYY-MM-DD");
    }

    const { shownWeeks, weekRange } = await import("@app/clarity/lib/month-fill");

    for (const { month, year } of monthsToRead(date)) {
        const { plan } = await (deps.preview ?? livePreview)({ month, year });
        const found = shownWeeks(plan).find((week) => {
            const { start, finishExclusive } = weekRange(week);
            return start <= date && date < finishExclusive;
        });

        if (found) {
            const rows = await rowsOf(found);
            const { start, finishExclusive } = weekRange(found);
            return {
                month,
                year,
                week: {
                    timesheetId: found.timesheetId,
                    periodStart: start,
                    periodFinish: finishExclusive,
                    rows,
                    unmapped: found.unmappedWorkItems,
                    totalMinutes: rows.reduce((sum, row) => sum + row.totalMinutes, 0),
                    revision: weekRevision(rows),
                },
            };
        }
    }

    return null;
}

/** The week that holds `date`, or null when Clarity has no timesheet for it. */
export async function timesheetWeek(date: string, deps: TimesheetDeps = {}): Promise<TimesheetWeekDto | null> {
    return (await findWeek(date, deps))?.week ?? null;
}

export async function fillTimesheetWeek(
    input: TimesheetFillInput,
    deps: TimesheetDeps = {}
): Promise<TimesheetFillReceiptDto> {
    const found = await findWeek(input.date, deps);
    const refused = (error: string): TimesheetFillReceiptDto => ({
        filled: false,
        written: 0,
        failed: 0,
        skipped: 0,
        error,
    });

    if (!found || found.week.timesheetId !== input.timesheetId) {
        return refused("Clarity has no such timesheet for that week any more.");
    }

    if (found.week.revision !== input.revision) {
        return refused("The week changed since the phone showed it; read it again.");
    }

    const { describeRefusal, fillTally } = await import("@app/clarity/lib/month-fill");
    const result = await (deps.execute ?? liveExecute)({
        month: found.month,
        year: found.year,
        weekIds: [input.timesheetId],
    });

    if (result.refusal) {
        return refused(describeRefusal(result.refusal, found));
    }

    const tally = fillTally(result);
    logger.info({ timesheetId: input.timesheetId, ...tally }, "timesheet: filled a week");
    return {
        filled: tally.failed === 0,
        written: tally.written,
        failed: tally.failed,
        skipped: tally.skipped,
        error: null,
    };
}
