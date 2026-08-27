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
 *   tools cmux send-self <text> [--no-enter]
 */

import { registerDoctorCommand } from "@app/cmux/commands/doctor";
import { registerProfilesCommand } from "@app/cmux/commands/profiles";
import { registerRescueCommand } from "@app/cmux/commands/rescue";
import { registerSendSelfCommand } from "@app/cmux/commands/send-self";
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
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
registerSendSelfCommand(program);
registerDoctorCommand(program);
registerRescueCommand(program);

enhanceHelp(program);

await runTool(program, { tool: "cmux" }).catch((error) => {
    out.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
