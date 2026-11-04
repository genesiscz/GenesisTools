/**
 * The Friday timesheet swipe (F27): one Clarity week as the phone shows it, and its fill. Types only
 * (`contract-purity.test.ts`). The rows are the Clarity dashboard's own preview (`getFillPreview`): Timely and ADO
 * time logs mapped to Clarity tasks. A fill writes real hours, so it is a keyed write that names the revision the
 * phone showed; the Mac reads the week again and refuses when it changed.
 */

export interface TimesheetItemDto {
    workItemId: number;
    title: string;
    minutes: number;
}

export interface TimesheetRowDto {
    task: string;
    code: string;
    /** Minutes per day (`YYYY-MM-DD`) the fill will write. */
    minutesByDay: Record<string, number>;
    totalMinutes: number;
    /** What Clarity holds now for this task in this week. */
    clarityMinutes: number | null;
    items: TimesheetItemDto[];
}

export interface TimesheetWeekDto {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    rows: TimesheetRowDto[];
    /** Logged time with no Clarity task mapped; the fill leaves it out. */
    unmapped: Array<{ workItemId: number; minutes: number }>;
    totalMinutes: number;
    /** A hash of the rows; the fill refuses when the week no longer matches it. */
    revision: string;
}

export interface TimesheetFillInput {
    /** Any day of the week, `YYYY-MM-DD`. */
    date: string;
    timesheetId: number;
    revision: string;
}

export interface TimesheetFillReceiptDto {
    filled: boolean;
    written: number;
    failed: number;
    skipped: number;
    /** Why nothing was written: the week changed, or the Clarity call failed. */
    error: string | null;
}
