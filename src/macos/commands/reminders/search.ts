import { MacReminders } from "@app/utils/macos/apple-reminders";
import type { Command } from "commander";
import { formatRemindersTable } from "./format";

interface SearchOptions {
    list?: string;
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search <query>")
        .description("Search reminders by title or notes")
        .option("--list <name>", "Filter by reminder list name")
        .action(async (query: string, options: SearchOptions) => {
            try {
                const reminders = await MacReminders.searchReminders(query, options.list);

                if (reminders.length === 0) {
                    console.log("No reminders found matching your query.");
                    return;
                }

                console.log(formatRemindersTable(reminders));
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
