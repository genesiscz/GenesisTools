#!/usr/bin/env bun

/**
 * cmux profile manager — save, view, restore cmux workspace layouts.
 *
 * Usage:
 *   tools cmux profiles save [<name>]
 *   tools cmux profiles list
 *   tools cmux profiles view <name>
 *   tools cmux profiles restore <name>
 *   tools cmux profiles edit <name>
 *   tools cmux profiles delete <name>
 *   tools cmux profiles path <name>
 */

import { registerProfilesCommand } from "@app/cmux/commands/profiles";
import { enhanceHelp } from "@app/utils/cli";
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";

handleReadmeFlag(import.meta.url);

const program = new Command();

program
    .name("cmux")
    .description("Save, inspect, and restore cmux workspace profiles.")
    .version("0.1.0")
    .showHelpAfterError(true)
    .option("-v, --verbose", "Enable debug logging");

registerProfilesCommand(program);

enhanceHelp(program);

program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
