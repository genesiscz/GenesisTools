import { MacReminders } from "@app/utils/macos/apple-reminders";
import type { Command } from "commander";
import pc from "picocolors";

interface RemoveOptions {
    complete?: boolean;
}

export function registerRemoveCommand(program: Command): void {
    program
        .command("remove <id>")
        .description("Remove a reminder (or mark it as complete)")
        .option("--complete", "Mark as complete instead of deleting")
        .action(async (id: string, options: RemoveOptions) => {
            try {
                if (options.complete) {
                    const ok = await MacReminders.completeReminder({
                        reminderId: id,
                    });

                    if (ok) {
                        console.log(`${pc.green("Reminder completed")} — ID: ${id}`);
                    } else {
                        console.error(`${pc.red("Failed to complete reminder")} — ID: ${id}`);
                        process.exit(1);
                    }

                    return;
                }

                const ok = await MacReminders.deleteReminder({
                    reminderId: id,
                });

                if (ok) {
                    console.log(`${pc.green("Reminder deleted")} — ID: ${id}`);
                } else {
                    console.error(`${pc.red("Failed to delete reminder")} — ID: ${id}`);
                    process.exit(1);
                }
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        });
}
