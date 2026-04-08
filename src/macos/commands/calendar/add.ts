import { parseDate } from "@app/utils/date";
import { MacCalendar } from "@app/utils/macos/apple-calendar";
import type { Command } from "commander";
import pc from "picocolors";
import { createAlertOption } from "./format";

export function registerAddCommand(program: Command): void {
    program
        .command("add <title>")
        .description("Create a new calendar event")
        .requiredOption("--start <datetime>", "Start date/time (e.g. 2026-04-10T14:00)")
        .option("--end <datetime>", "End date/time (defaults to 30 min after start)")
        .option("--calendar <name>", "Calendar name", "GenesisTools")
        .option("--notes <text>", "Event notes")
        .option("--url <url>", "Event URL")
        .option("--location <text>", "Event location")
        .addOption(createAlertOption())
        .option("--all-day", "Mark as all-day event")
        .action(
            async (
                title: string,
                options: {
                    start: string;
                    end?: string;
                    calendar: string;
                    notes?: string;
                    url?: string;
                    location?: string;
                    alert: number[];
                    allDay?: boolean;
                }
            ) => {
                try {
                    const startDate = parseDate(options.start);
                    const endDate = options.end ? parseDate(options.end) : undefined;

                    const eventId = await MacCalendar.createEvent({
                        title,
                        startDate,
                        endDate,
                        calendarName: options.calendar,
                        notes: options.notes,
                        url: options.url,
                        location: options.location,
                        alerts: options.alert.length > 0 ? options.alert : undefined,
                        isAllDay: options.allDay,
                    });

                    console.log(`${pc.green("Event created")} — ID: ${eventId}`);
                } catch (error) {
                    console.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                }
            }
        );
}
