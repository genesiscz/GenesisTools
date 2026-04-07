import { MacReminders } from "@app/utils/macos/apple-reminders";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

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

                const rows = lists.map((list) => [list.title, list.source, pc.bold(list.color)]);

                const table = formatTable(rows, ["Title", "Source", "Color"]);
                console.log(table);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
