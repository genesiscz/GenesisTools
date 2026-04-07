import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { type Command, Option } from "commander";
import pc from "picocolors";

export function registerUpdateCommand(program: Command): void {
    program
        .command("update <event-id>")
        .description("Update an existing calendar event")
        .option("--title <text>", "New event title")
        .option("--start <datetime>", "New start date/time")
        .option("--end <datetime>", "New end date/time")
        .option("--calendar <name>", "Move to a different calendar")
        .option("--notes <text>", "Update event notes")
        .option("--url <url>", "Update event URL")
        .option("--location <text>", "Update event location")
        .addOption(
            new Option("--alert <minutes>", "Alert before event in minutes (repeatable)")
                .argParser((value: string, previous: number[]) => {
                    const mins = Number.parseInt(value, 10);

                    if (Number.isNaN(mins)) {
                        throw new Error(`Invalid alert value: ${value}`);
                    }

                    return [...(previous ?? []), mins];
                })
                .default([])
        )
        .option("--all-day", "Mark as all-day event")
        .action(
            async (
                eventId: string,
                options: {
                    title?: string;
                    start?: string;
                    end?: string;
                    calendar?: string;
                    notes?: string;
                    url?: string;
                    location?: string;
                    alert: number[];
                    allDay?: boolean;
                }
            ) => {
                try {
                    let startDate: Date | undefined;

                    if (options.start) {
                        startDate = new Date(options.start);

                        if (Number.isNaN(startDate.getTime())) {
                            throw new Error(`Invalid start date: ${options.start}`);
                        }
                    }

                    let endDate: Date | undefined;

                    if (options.end) {
                        endDate = new Date(options.end);

                        if (Number.isNaN(endDate.getTime())) {
                            throw new Error(`Invalid end date: ${options.end}`);
                        }
                    }

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
