import { Command } from "commander";
import { registerAddCommand } from "./add";
import { registerListCommand } from "./list";
import { registerListListsCommand } from "./list-lists";
import { registerRemoveCommand } from "./remove";
import { registerSearchCommand } from "./search";

export function registerRemindersCommand(program: Command): void {
    const reminders = new Command("reminders");
    reminders.description("Manage macOS Reminders (list, search, add, remove)").showHelpAfterError(true);

    registerListListsCommand(reminders);
    registerListCommand(reminders);
    registerSearchCommand(reminders);
    registerAddCommand(reminders);
    registerRemoveCommand(reminders);

    program.addCommand(reminders);
}
