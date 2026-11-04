import {
    type DashboardClient,
    ENDPOINTS,
    type TimesheetFillReceiptDto,
    type TimesheetRowDto,
    type TimesheetWeekDto,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const timesheetKeys = { week: (date: string) => ["timesheet", "week", date] as const };

/** The phone's local day as `YYYY-MM-DD`. */
export function localDay(date = new Date()): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function weekQuery(client: DashboardClient, date: string) {
    return queryOptions<TimesheetWeekDto | null>({
        queryKey: timesheetKeys.week(date),
        queryFn: () => client.call(ENDPOINTS.gatewayTimesheet, { date }),
    });
}

export function fillWeek(
    client: DashboardClient,
    input: { date: string; timesheetId: number; revision: string; idempotencyKey: string }
): Promise<TimesheetFillReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.timesheetFill, body, { idempotencyKey });
}

export function hours(minutes: number): string {
    return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 2)} h`;
}

/** "Mon 2 h · Tue 3.50 h", the days with time only. */
export function dayLine(row: TimesheetRowDto): string {
    return Object.entries(row.minutesByDay)
        .filter(([, minutes]) => minutes > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, minutes]) => `${new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" })} ${hours(minutes)}`)
        .join(" · ");
}

/** The fill waits until every row was accepted, so a swipe through the week is the review. */
export function allAccepted(week: TimesheetWeekDto | null | undefined, accepted: ReadonlySet<string>): boolean {
    return Boolean(week && week.rows.length > 0 && week.rows.every((row) => accepted.has(row.code)));
}

/** The Friday reminder: weekday 6 is Friday in the Apple calendar (1 is Sunday). */
export const FRIDAY_REMINDER = { id: "dd-timesheet-friday", weekday: 6, hour: 15, minute: 0 } as const;
