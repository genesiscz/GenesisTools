import { createHash } from "node:crypto";
import type {
    TimesheetFillInput,
    TimesheetFillReceiptDto,
    TimesheetRowDto,
    TimesheetWeekDto,
} from "@app/dev-dashboard/contract/timesheet";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The Friday timesheet swipe (F27): the week of a date as the Clarity dashboard previews it, and its fill. Both go
 * through the dashboard's own server functions (`src/clarity/ui/src/server/fill.ts`), so the phone, the dashboard
 * and `tools clarity fill` plan the same rows. The fill names the revision the phone showed and is refused when the
 * week read again no longer matches it.
 */

type FillPreview = Awaited<ReturnType<typeof import("@app/clarity/ui/src/server/fill").getFillPreview>>;
type PreviewWeek = FillPreview["weeks"][number];
type FillResult = Awaited<ReturnType<typeof import("@app/clarity/ui/src/server/fill").executeFill>>;

export interface TimesheetDeps {
    preview?: (month: number, year: number) => Promise<FillPreview>;
    execute?: (month: number, year: number, weekIds: number[]) => Promise<FillResult>;
}

async function livePreview(month: number, year: number): Promise<FillPreview> {
    const { getFillPreview } = await import("@app/clarity/ui/src/server/fill");
    return getFillPreview(month, year);
}

async function liveExecute(month: number, year: number, weekIds: number[]): Promise<FillResult> {
    const { executeFill } = await import("@app/clarity/ui/src/server/fill");
    return executeFill(month, year, weekIds);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The week of a day is planned in the month its period starts in; a week can start in the month before. */
function monthsToRead(date: string): Array<{ month: number; year: number }> {
    const [year, month] = date.split("-").map(Number);
    const previous = month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
    return [{ month, year }, previous];
}

function rowsOf(week: PreviewWeek): TimesheetRowDto[] {
    return week.entries.map((entry) => ({
        task: entry.clarityTaskName,
        code: entry.clarityTaskCode,
        minutesByDay: entry.dayValues,
        totalMinutes: entry.totalMinutes,
        clarityMinutes: entry.clarityCurrentMinutes ?? null,
        items: entry.timelogEntries.map((item) => ({
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

    for (const { month, year } of monthsToRead(date)) {
        const preview = await (deps.preview ?? livePreview)(month, year);
        const found = preview.weeks.find((week) => week.periodStart <= date && date <= week.periodFinish);

        if (found) {
            const rows = rowsOf(found);
            return {
                month,
                year,
                week: {
                    timesheetId: found.timesheetId,
                    periodStart: found.periodStart,
                    periodFinish: found.periodFinish,
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

    const result = await (deps.execute ?? liveExecute)(found.month, found.year, [input.timesheetId]);
    logger.info({ timesheetId: input.timesheetId, ...result, entries: undefined }, "timesheet: filled a week");
    return {
        filled: result.failed === 0,
        written: result.success,
        failed: result.failed,
        skipped: result.skipped,
        error: null,
    };
}
