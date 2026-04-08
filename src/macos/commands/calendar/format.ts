import type { CalendarEventInfo } from "@app/utils/macos/apple-calendar";
import { formatTable } from "@app/utils/table";
import { Option } from "commander";

export function formatDateTime(iso: string): string {
    const d = new Date(iso);

    if (Number.isNaN(d.getTime())) {
        return "";
    }

    return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function normalizeEndOfDay(date: Date): Date {
    if (date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    }

    return date;
}

export function createAlertOption(): Option {
    return new Option("--alert <minutes>", "Alert before event in minutes (repeatable)")
        .argParser((value: string, previous: number[]) => {
            const mins = Number(value);

            if (!Number.isInteger(mins)) {
                throw new Error(`Invalid alert value: ${value}`);
            }

            return [...(previous ?? []), mins];
        })
        .default([]);
}

export function formatEventsTable(events: CalendarEventInfo[]): string {
    const rows = events.map((e) => [
        e.title,
        e.is_all_day ? "All day" : formatDateTime(e.start_date),
        e.is_all_day ? "" : formatDateTime(e.end_date),
        e.calendar_title,
        e.location ?? "",
    ]);

    return formatTable(rows, ["Title", "Start", "End", "Calendar", "Location"]);
}
