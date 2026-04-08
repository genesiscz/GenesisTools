import { MacReminders } from "@app/utils/macos/apple-reminders";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

function colorDot(hex: string): string {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m●\x1b[0m`;
}

export function registerListListsCommand(program: Command): void {
    program
        .command("list-lists")
        .description("List all available reminder lists")
        .action(async () => {
            try {
                const lists = await MacReminders.listLists();

                if (lists.length === 0) {
                    console.log("No reminder lists found.");
                    return;
                }

                const rows = lists.map((list) => [list.title, list.source, `${colorDot(list.color)} ${list.color}`]);

                const table = formatTable(rows, ["Title", "Source", "Color"]);
                console.log(table);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
