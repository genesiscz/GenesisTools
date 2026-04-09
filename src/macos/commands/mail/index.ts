// src/macos/commands/mail/index.ts

import { Command } from "commander";
import { registerAccountsCommand } from "./accounts";
import { registerDownloadCommand } from "./download";
import { registerIndexCommand } from "./index-cmd";
import { registerListCommand } from "./list";
import { registerMonitorCommand } from "./monitor";
import { registerSearchCommand } from "./search";
import { registerShowCommand } from "./show";

/**
 * Register the `mail` subcommand on the parent program.
 * Usage: tools macos mail <search|list|download|index|monitor> [options]
 */
export function registerMailCommand(program: Command): void {
    const mail = new Command("mail");
    mail.description("Search, list, and download emails from macOS Mail.app").showHelpAfterError(true);

    registerSearchCommand(mail);
    registerListCommand(mail);
    registerDownloadCommand(mail);
    registerIndexCommand(mail);
    registerMonitorCommand(mail);
    registerAccountsCommand(mail);
    registerShowCommand(mail);

    program.addCommand(mail);
}
