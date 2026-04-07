import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { type Command, Option } from "commander";
import pc from "picocolors";

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
                    const startDate = new Date(options.start);

                    if (Number.isNaN(startDate.getTime())) {
                        throw new Error(`Invalid start date: ${options.start}`);
                    }

                    let endDate: Date | undefined;

                    if (options.end) {
                        endDate = new Date(options.end);

                        if (Number.isNaN(endDate.getTime())) {
                            throw new Error(`Invalid end date: ${options.end}`);
                        }
                    }

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
