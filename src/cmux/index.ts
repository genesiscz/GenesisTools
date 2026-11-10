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

import { CMUX_REGISTRARS } from "@app/cmux/registrars";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";

const program = new Command();

program
    .name("cmux")
    .description("Save, inspect, and restore cmux workspace profiles.")
    .version("0.1.0")
    .showHelpAfterError(true)
    .option("-v, --verbose", "Enable debug logging");

await runTool(program, { tool: "cmux", registrars: CMUX_REGISTRARS, enhanceHelp: true });
