import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { MacReminders } from "@app/utils/macos/apple-reminders";
import { type Command, Option } from "commander";
import { formatRemindersTable } from "./format";

interface ListOptions {
    includeCompleted?: boolean;
    format?: string;
}

export function registerListCommand(program: Command): void {
    program
        .command("list [name]")
        .description("List reminders (optionally filtered by list name)")
        .option("--include-completed", "Include completed reminders")
        .addOption(
            new Option("-f, --format <type>", "Output format: table, json").choices(["table", "json"]).default("table")
        )
        .action(async (name: string | undefined, options: ListOptions) => {
            try {
                const reminders = await MacReminders.listReminders(name, {
                    includeCompleted: options.includeCompleted,
                });

                if (reminders.length === 0) {
                    out.println("No reminders found.");
                    return;
                }

                const format = options.format ?? "table";

                if (format === "json") {
                    out.println(SafeJSON.stringify(reminders, null, 2));
                } else {
                    out.println(formatRemindersTable(reminders));
                }
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
