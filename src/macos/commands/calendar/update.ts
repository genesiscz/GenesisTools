import { parseDate } from "@app/utils/date";
import { MacCalendar } from "@app/utils/macos/apple-calendar";
import type { Command } from "commander";
import pc from "picocolors";
import { createAlertOption } from "./format";

export function registerUpdateCommand(program: Command): void {
    program
        .command("update <event-id>")
        .description("Update an existing calendar event")
        .option("--title <text>", "New event title")
        .option("--start <datetime>", "New start date/time")
        .option("--end <datetime>", "New end date/time")
        .option("--notes <text>", "Update event notes")
        .option("--url <url>", "Update event URL")
        .option("--location <text>", "Update event location")
        .addOption(createAlertOption())
        .option("--all-day", "Mark as all-day event")
        .action(
            async (
                eventId: string,
                options: {
                    title?: string;
                    start?: string;
                    end?: string;
                    notes?: string;
                    url?: string;
                    location?: string;
                    alert: number[];
                    allDay?: boolean;
                }
            ) => {
                try {
                    const startDate = options.start ? parseDate(options.start) : undefined;
                    const endDate = options.end ? parseDate(options.end) : undefined;

                    const updatedId = await MacCalendar.updateEvent(eventId, {
                        title: options.title,
                        startDate,
                        endDate,
                        notes: options.notes,
                        url: options.url,
                        location: options.location,
                        alerts: options.alert.length > 0 ? options.alert : undefined,
                        isAllDay: options.allDay,
                    });

                    console.log(`${pc.green("Event updated")} — ID: ${updatedId}`);
                } catch (error) {
                    console.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                }
            }
        );
}
