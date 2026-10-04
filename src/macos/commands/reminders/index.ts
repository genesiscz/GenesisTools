import { Command } from "commander";
import { registerAddCommand } from "./add";
import { registerDoctorCommand } from "./doctor";
import { registerListCommand } from "./list";
import { registerListListsCommand } from "./list-lists";
import { registerRemoveCommand } from "./remove";
import { registerSearchCommand } from "./search";

export function registerRemindersCommand(program: Command): void {
    const reminders = new Command("reminders");
    reminders.description("Manage macOS Reminders (doctor, list, search, add, remove)").showHelpAfterError(true);

    registerDoctorCommand(reminders);
    registerListListsCommand(reminders);
    registerListCommand(reminders);
    registerSearchCommand(reminders);
    registerAddCommand(reminders);
    registerRemoveCommand(reminders);

    program.addCommand(reminders);
}
