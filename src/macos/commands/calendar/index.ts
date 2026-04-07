import { Command } from "commander";
import { registerAddCommand } from "./add";
import { registerDeleteCommand } from "./delete";
import { registerListCommand } from "./list";
import { registerListCalendarsCommand } from "./list-calendars";
import { registerSearchCommand } from "./search";
import { registerUpdateCommand } from "./update";

export function registerCalendarCommand(program: Command): void {
    const calendar = new Command("calendar");
    calendar.description("Manage macOS Calendar events (list, search, add, update, delete)").showHelpAfterError(true);

    registerListCalendarsCommand(calendar);
    registerListCommand(calendar);
    registerSearchCommand(calendar);
    registerAddCommand(calendar);
    registerUpdateCommand(calendar);
    registerDeleteCommand(calendar);

    program.addCommand(calendar);
}
