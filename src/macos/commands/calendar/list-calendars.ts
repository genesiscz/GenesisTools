import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

export function registerListCalendarsCommand(program: Command): void {
    program
        .command("list-calendars")
        .description("List all available calendars")
        .action(async () => {
            try {
                const calendars = await MacCalendar.listCalendars();

                if (calendars.length === 0) {
                    console.log("No calendars found.");
                    return;
                }

                const rows = calendars.map((cal) => [
                    cal.title,
                    cal.source,
                    cal.type,
                    pc.bold(cal.color),
                    cal.allows_content_modifications ? pc.green("Yes") : pc.red("No"),
                ]);

                const table = formatTable(rows, ["Title", "Source", "Type", "Color", "Editable"]);
                console.log(table);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
