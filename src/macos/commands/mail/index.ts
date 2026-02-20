// src/macos/commands/mail/index.ts

import { Command } from "commander";
import { registerSearchCommand } from "./search";
import { registerListCommand } from "./list";
import { registerDownloadCommand } from "./download";

/**
 * Register the `mail` subcommand on the parent program.
 * Usage: tools macos mail <search|list|download> [options]
 */
export function registerMailCommand(program: Command): void {
    const mail = new Command("mail");
    mail
        .description("Search, list, and download emails from macOS Mail.app")
        .showHelpAfterError(true);

    registerSearchCommand(mail);
    registerListCommand(mail);
    registerDownloadCommand(mail);

    program.addCommand(mail);
}
