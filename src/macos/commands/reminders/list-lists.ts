import { MacReminders } from "@app/utils/macos/apple-reminders";
import { formatTable } from "@app/utils/table";
import chalk from "chalk";
import type { Command } from "commander";

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

                const rows = lists.map((list) => [chalk.hex(list.color)(`● ${list.title}`), list.source]);

                const table = formatTable(rows, ["Title", "Source"]);
                console.log(table);
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
