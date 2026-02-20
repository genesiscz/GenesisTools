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
 * Future subcommands:
 *   tools macos calendar events
 *   tools macos contacts search
 */

import logger from "@app/logger";
import { registerMailCommand } from "@app/macos/commands/mail/index";
import { Command } from "commander";

const program = new Command();

program
    .name("macos")
    .description("Interact with macOS native frameworks (Mail, Calendar, Contacts, ...)")
    .version("1.0.0")
    .showHelpAfterError(true);

registerMailCommand(program);

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
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
