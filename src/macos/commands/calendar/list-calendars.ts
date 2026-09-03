import { out } from "@genesiscz/utils/logger";
import { isPlaceholderCalendarList, MacCalendar } from "@genesiscz/utils/macos/apple-calendar";
import { formatTable } from "@genesiscz/utils/table";
import chalk from "chalk";
import type { Command } from "commander";

export function registerListCalendarsCommand(program: Command): void {
    program
        .command("list-calendars")
        .description("List all available calendars")
        .action(async () => {
            try {
                const [calendars, sources] = await Promise.all([MacCalendar.listCalendars(), MacCalendar.getSources()]);

                if (calendars.length === 0) {
                    out.println("No calendars found.");
                    return;
                }

                if (isPlaceholderCalendarList(calendars)) {
                    out.log.warn(
                        "This is the EventKit placeholder calendar, not your data: the process lacks Full Access. Run `tools macos calendar doctor`."
                    );
                }

                const sourceTypeByTitle = new Map(sources.map((s) => [s.title, s.source_type]));
                const rows = calendars.map((cal) => [
                    chalk.hex(cal.color)(`● ${cal.title}`),
                    cal.source,
                    sourceTypeByTitle.get(cal.source) ?? "?",
                    cal.type,
                    cal.allows_content_modifications ? chalk.green("Yes") : chalk.red("No"),
                ]);

                const table = formatTable(rows, ["Title", "Source", "Source type", "Type", "Editable"]);
                out.println(table);
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
