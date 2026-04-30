#!/usr/bin/env bun

/**
 * macOS Native Tools
 *
 * Umbrella tool for interacting with macOS native frameworks.
 *
 * Usage:
 *   tools macos mail search <query> [options]
 *   tools macos mail list [mailbox] [options]
 *   tools macos mail download <output-dir> [options]
 *
 *   tools macos voice-memos list
 *   tools macos voice-memos play <id>
 *   tools macos voice-memos export <id> [dest]
 *   tools macos voice-memos transcribe [id] [--all] [--force]
 *   tools macos voice-memos search <query>
 *
 *   tools macos calendar list-calendars
 *   tools macos calendar list [name] [--from/--to]
 *   tools macos calendar search <query>
 *   tools macos calendar add <title> --start <datetime>
 *   tools macos calendar update <event-id> [options]
 *   tools macos calendar delete <event-id>
 *
 *   tools macos reminders list-lists
 *   tools macos reminders list [name] [--include-completed]
 *   tools macos reminders search <query> [--list <name>]
 *   tools macos reminders add <title> [--list/--due/--priority/--notes/--url]
 *   tools macos reminders remove <id> [--complete]
 *
 *   tools macos messages list [options]
 *   tools macos messages search <query> [options]
 *   tools macos messages show <identifier> [options]
 *
 *   tools macos swap [--limit n] [--top n] [--all] [--json]
 *
 * Future subcommands:
 *   tools macos contacts search
 */

import logger from "@app/logger";
import { registerCalendarCommand } from "@app/macos/commands/calendar/index";
import { registerMailCommand } from "@app/macos/commands/mail/index";
import { registerMessagesCommand } from "@app/macos/commands/messages/index";
import { registerRemindersCommand } from "@app/macos/commands/reminders/index";
import { registerSleepCommand } from "@app/macos/commands/sleep/index";
import { registerSwapCommand } from "@app/macos/commands/swap/index";
import { registerVoiceMemosCommand } from "@app/macos/commands/voice-memos/index";
import { closeDarwinKit } from "@app/utils/macos/darwinkit";
import { Command } from "commander";

const program = new Command();

program
    .name("macos")
    .description("Interact with macOS native frameworks (Mail, Calendar, Contacts, ...)")
    .version("1.0.0")
    .showHelpAfterError(true);

registerCalendarCommand(program);
registerMailCommand(program);
registerMessagesCommand(program);
registerRemindersCommand(program);
registerSleepCommand(program);
registerSwapCommand(program);
registerVoiceMemosCommand(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

        if (message.includes("not authorized") || message.includes("permission")) {
            console.log("\nTo fix permission issues:");
            console.log("  1. Open System Settings > Privacy & Security > Full Disk Access");
            console.log("  2. Enable access for your terminal app");
            console.log("  3. Restart the terminal and try again");
        }

        process.exit(1);
    } finally {
        closeDarwinKit();
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
