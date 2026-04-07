import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

interface SearchOptions {
    calendar?: string;
    from?: string;
    to?: string;
}

function parseDate(input: string): Date {
    const d = new Date(input);

    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid date: ${input}`);
    }

    return d;
}

function formatDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search <query>")
        .description("Search calendar events by title, notes, or location")
        .option("--calendar <name>", "Filter by calendar name")
        .option("--from <date>", "Start date (e.g. 2026-04-01)")
        .option("--to <date>", "End date (e.g. 2026-04-30)")
        .action(async (query: string, options: SearchOptions) => {
            try {
                const from = options.from ? parseDate(options.from) : undefined;
                const to = options.to ? parseDate(options.to) : undefined;

                const events = await MacCalendar.searchEvents(query, {
                    calendarName: options.calendar,
                    from,
                    to,
                });

                if (events.length === 0) {
                    console.log("No events found matching your query.");
                    return;
                }

                const rows = events.map((e) => [
                    e.title,
                    e.is_all_day ? "All day" : formatDateTime(e.start_date),
                    e.is_all_day ? "" : formatDateTime(e.end_date),
                    e.calendar_title,
                    e.location ?? "",
                ]);

                const table = formatTable(rows, ["Title", "Start", "End", "Calendar", "Location"]);
                console.log(table);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
