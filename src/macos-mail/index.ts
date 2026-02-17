#!/usr/bin/env bun

/**
 * macOS Mail CLI Tool
 *
 * Search, list, and download emails from Mail.app.
 * Uses a hybrid SQLite + JXA approach for performance.
 *
 * Usage:
 *   tools macos-mail search <query> [options]
 *   tools macos-mail list [mailbox] [options]
 *   tools macos-mail download <output-dir> [options]
 */

import { handleReadmeFlag } from "@app/utils/readme";
import logger from "@app/logger";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

import { registerSearchCommand } from "@app/macos-mail/commands/search";
import { registerListCommand } from "@app/macos-mail/commands/list";
import { registerDownloadCommand } from "@app/macos-mail/commands/download";

const program = new Command();

program
    .name("macos-mail")
    .description("Search, list, and download emails from macOS Mail.app")
    .version("1.0.0")
    .showHelpAfterError(true);

// Register all commands
registerSearchCommand(program);
registerListCommand(program);
registerDownloadCommand(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

        // Check for common permission errors
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
