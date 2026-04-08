import { parseDate } from "@app/utils/date";
import { MacReminders, ReminderPriority } from "@app/utils/macos/apple-reminders";
import { type Command, Option } from "commander";
import pc from "picocolors";

export function registerAddCommand(program: Command): void {
    program
        .command("add <title>")
        .description("Create a new reminder")
        .option("--list <name>", "Reminder list name", "GenesisTools")
        .option("--due <datetime>", "Due date/time (e.g. 2026-04-10T14:00)")
        .addOption(
            new Option("--priority <level>", "Priority level")
                .choices(["high", "medium", "low", "none"])
                .default("none")
        )
        .option("--notes <text>", "Reminder notes")
        .option("--url <url>", "Reminder URL")
        .action(
            async (
                title: string,
                options: {
                    list: string;
                    due?: string;
                    priority: string;
                    notes?: string;
                    url?: string;
                }
            ) => {
                try {
                    const dueDate = options.due ? parseDate(options.due) : undefined;

                    const priority =
                        options.priority === "none"
                            ? ReminderPriority.none
                            : ReminderPriority[options.priority as keyof typeof ReminderPriority];

                    const reminderId = await MacReminders.createReminder({
                        title,
                        listName: options.list,
                        dueDate,
                        priority,
                        notes: options.notes,
                        url: options.url,
                    });

                    console.log(`${pc.green("Reminder created")} — ID: ${reminderId}`);
                } catch (error) {
                    console.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                }
            }
        );
}
