#!/usr/bin/env bun

/**
 * tools control — macOS UI automation umbrella.
 *
 * Element automation (native ax-tool binary): list/tree/find/window/attrs/
 * actions/preflight, get/set/press/perform/focus/click/type/hotkey/screenshot,
 * snapshot/restore, plan runner (run).
 *
 * Recording (capture subcommand group): declarative peekaboo capture + timed
 * UI actions — run/recrop/clickmap/preflight over lib/capture-runner.ts.
 */

import { runTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerControlCommands } from "./commands";

const program = new Command();

program
    .name("control")
    .description(
        "macOS UI automation — element control via the Accessibility API, plus screen recording with timed actions (capture).\nStart with `control see --app <name>` for indexed snapshot inspection and `control act` for validated actions. Use `control preflight --app <name>` for legacy discovery and recording plans.\nDiscover valid --app values with `control apps`."
    )
    .version("1.0.0");

registerControlCommands(program);

try {
    await runTool(program, { tool: "control" });
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exit(1);
}
