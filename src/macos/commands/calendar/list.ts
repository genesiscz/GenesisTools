import { parseDate } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import type { CalendarEventInfo } from "@app/utils/macos/apple-calendar";
import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { type Command, Option } from "commander";
import { formatDateTime, formatEventsTable, normalizeEndOfDay } from "./format";

interface ListOptions {
    from?: string;
    to?: string;
    format?: string;
}

function formatEventsMd(events: CalendarEventInfo[]): string {
    const lines = events.map((e) => {
        const time = e.is_all_day ? "All day" : `${formatDateTime(e.start_date)} - ${formatDateTime(e.end_date)}`;
        const location = e.location ? ` | ${e.location}` : "";
        return `- **${e.title}** — ${time} [${e.calendar_title}]${location}`;
    });

    return lines.join("\n");
}

export function registerListCommand(program: Command): void {
    program
        .command("list [name]")
        .description("List calendar events (optionally filtered by calendar name)")
        .option("--from <date>", "Start date (e.g. 2026-04-01)")
        .option("--to <date>", "End date (e.g. 2026-04-30)")
        .addOption(
            new Option("-f, --format <type>", "Output format: table, json, md")
                .choices(["table", "json", "md"])
                .default("table")
        )
        .action(async (name: string | undefined, options: ListOptions) => {
            try {
                const from = options.from ? parseDate(options.from) : undefined;
                const to = options.to ? normalizeEndOfDay(parseDate(options.to)) : undefined;

                const events = await MacCalendar.listEvents({
                    calendarName: name,
                    from,
                    to,
                });

                const format = options.format ?? "table";

                if (events.length === 0) {
                    console.log(format === "json" ? "[]" : "No events found.");
                    return;
                }

                if (format === "json") {
                    console.log(SafeJSON.stringify(events, null, 2));
                } else if (format === "md") {
                    console.log(formatEventsMd(events));
                } else {
                    console.log(formatEventsTable(events));
                }
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
