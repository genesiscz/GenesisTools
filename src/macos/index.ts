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
 *   tools macos permissions [status|build|ui|enable|disable|open --pane <name>]
 *
 *   tools macos doctor [--json]    (every read-only check below, in one pass)
 *
 *   tools macos calendar doctor
 *   tools macos calendar list-calendars
 *   tools macos calendar list [name] [--from/--to]
 *   tools macos calendar search <query>
 *   tools macos calendar add <title> --start <datetime>
 *   tools macos calendar update <event-id> [options]
 *   tools macos calendar delete <event-id>
 *
 *   tools macos reminders doctor
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
 *   tools macos eslogger [-e events | -c categories] [--filter-event expr] [-o file]
 *   tools macos eslogger --list-events
 *   tools macos eslogger --input recorded.jsonl [--filter-event expr]
 *
 * Future subcommands:
 *   tools macos contacts search
 */

import { runTool, type ToolErrorReport } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { MACOS_REGISTRARS } from "./registrars";

const program = new Command();

program
    .name("macos")
    .description("Interact with macOS native frameworks (Mail, Calendar, Contacts, ...)")
    .version("1.0.0")
    .showHelpAfterError(true);

/**
 * Every permission-aware path (MacDatabase, Voice Memos, Calendar) already prints the grant it needs, who holds it and
 * how to switch it on, so a permission error only gets a pointer to `macos permissions`.
 */
function formatMacosError(error: unknown): ToolErrorReport | undefined {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("not authorized") || message.includes("permission")) {
        return {
            message: `ERROR: ${message}\n\nRun \`${toolCommand("macos permissions")}\` to see which grants GenesisTools holds.`,
        };
    }

    return undefined;
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "macos", registrars: MACOS_REGISTRARS, formatError: formatMacosError });
    } finally {
        // No-op unless a command actually opened DarwinKit, and by then the
        // module is already in the loader cache, so this import is free. Doing
        // it here keeps it off the startup path for the nine trees that never
        // touch it.
        const { closeDarwinKit } = await import("@genesiscz/utils/macos/darwinkit");
        closeDarwinKit();
    }
}

try {
    await main();
} catch (err) {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
}
