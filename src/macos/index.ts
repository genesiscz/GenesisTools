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
 *   tools macos calendar doctor
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

import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";

/**
 * lazy: saves ~180 ms cold import and ~57 MB RSS on every recognised subcommand
 * (tools ts imports analyze, 2026-09-16) — importing all ten trees eagerly made
 * `tools macos clones measure` pay for Mail, Calendar, Reminders and Messages
 * before it did any work.
 *
 * Per-tree import cost of the old eager list, measured: mail 237 ms,
 * voice-memos 169 ms, clones 90 ms, messages 69 ms, calendar 37 ms,
 * reminders 35 ms, permissions 29 ms, swap 26 ms, sleep 23 ms, control 6 ms.
 * Mail alone was 237 ms of a 284 ms tree, so this is about the SUBCOMMANDS;
 * making DarwinKit (23 ms) lazy on its own measured no improvement at all.
 *
 * Help and an unknown subcommand still need every description, so those load
 * the lot and are deliberately no faster; only a recognised subcommand takes
 * the fast path. Insertion order below is the order `--help` prints, so it
 * mirrors the original registerX sequence rather than being sorted.
 */
const REGISTRARS: Record<string, () => Promise<(program: Command) => void>> = {
    // Insertion order IS the order `--help` lists them in, so this mirrors the
    // original sequence of registerX calls rather than sorting alphabetically:
    // `permissions` sat third and a diff of `tools macos --help` caught it moving.
    calendar: async () => (await import("@app/macos/commands/calendar/index")).registerCalendarCommand,
    clones: async () => (await import("@app/macos/commands/clones/index")).registerClonesCommand,
    permissions: async () => (await import("@app/macos/commands/permissions/index")).registerPermissionsCommand,
    control: async () => (await import("@app/macos/commands/control/index")).registerControlCommand,
    mail: async () => (await import("@app/macos/commands/mail/index")).registerMailCommand,
    messages: async () => (await import("@app/macos/commands/messages/index")).registerMessagesCommand,
    reminders: async () => (await import("@app/macos/commands/reminders/index")).registerRemindersCommand,
    sleep: async () => (await import("@app/macos/commands/sleep/index")).registerSleepCommand,
    swap: async () => (await import("@app/macos/commands/swap/index")).registerSwapCommand,
    "voice-memos": async () => (await import("@app/macos/commands/voice-memos/index")).registerVoiceMemosCommand,
};

const program = new Command();

program
    .name("macos")
    .description("Interact with macOS native frameworks (Mail, Calendar, Contacts, ...)")
    .version("1.0.0")
    .showHelpAfterError(true);

const requested = process.argv[2];
const toRegister = requested && requested in REGISTRARS ? [requested] : Object.keys(REGISTRARS);
for (const name of toRegister) {
    (await REGISTRARS[name]!())(program);
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "macos" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);

        // Every permission-aware path (MacDatabase, Voice Memos, Calendar) already prints the
        // grant it needs, who holds it and how to switch it on. A second generic block here used
        // to contradict them by naming the terminal, which stopped being the grant holder when
        // GenesisTools.app became the responsible process.
        if (message.includes("not authorized") || message.includes("permission")) {
            out.println("\nRun `tools macos permissions` to see which grants GenesisTools holds.");
        }

        process.exit(1);
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
