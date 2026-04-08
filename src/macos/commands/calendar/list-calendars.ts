import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

function colorDot(hex: string): string {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m●\x1b[0m`;
}

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
                    `${colorDot(cal.color)} ${cal.color}`,
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
