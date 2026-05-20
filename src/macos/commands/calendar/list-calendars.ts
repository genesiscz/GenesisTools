import { out } from "@app/logger";
import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { formatTable } from "@app/utils/table";
import chalk from "chalk";
import type { Command } from "commander";

export function registerListCalendarsCommand(program: Command): void {
    program
        .command("list-calendars")
        .description("List all available calendars")
        .action(async () => {
            try {
                const calendars = await MacCalendar.listCalendars();

                if (calendars.length === 0) {
                    out.print("No calendars found.");
                    return;
                }

                const rows = calendars.map((cal) => [
                    chalk.hex(cal.color)(`● ${cal.title}`),
                    cal.source,
                    cal.type,
                    cal.allows_content_modifications ? chalk.green("Yes") : chalk.red("No"),
                ]);

                const table = formatTable(rows, ["Title", "Source", "Type", "Editable"]);
                out.print(table);
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
