#!/usr/bin/env bun

/**
 * tools control — macOS UI automation umbrella.
 *
 * Element automation (native ax-tool binary): list/tree/find/window/attrs/
 * actions/preflight, get/set/press/perform/focus/click/type/hotkey/screenshot,
 * snapshot/restore, plan runner (run).
 *
 * Recording (capture subcommand): declarative peekaboo capture + timed UI
 * actions — forwarded verbatim to lib/capture-with-actions.ts.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { registerDiscoveryCommands } from "./commands/discovery";
import { registerInteractCommands } from "./commands/interact";
import { registerRunCommand } from "./commands/run";
import { registerStateCommands } from "./commands/state";

// `control capture ...` forwards raw args to the capture runner script, which
// does its own argv parsing (plan files, preflight, clickmap, --help). Handled
// before commander so flags pass through untouched.
const captureIdx = process.argv.indexOf("capture");
if (captureIdx === 2 || (captureIdx === 3 && process.argv[2]?.endsWith("index.ts"))) {
    const script = join(import.meta.dir, "lib", "capture-with-actions.ts");
    const r = spawnSync("bun", [script, ...process.argv.slice(captureIdx + 1)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
}

const program = new Command();

program
    .name("control")
    .description(
        "macOS UI automation — element control via the Accessibility API, plus screen recording with timed actions (capture).\nRUN `control preflight --app <name>` FIRST: one call returns screens, frontmost app, windows, element inventory, browser tab, and a suggested plan.\nDiscover valid --app values with `control apps`."
    )
    .version("1.0.0");

registerDiscoveryCommands(program);
registerInteractCommands(program);
registerRunCommand(program);
registerStateCommands(program);

program
    .command("capture [args...]")
    .description("Screen recording with timed UI actions (peekaboo capture live) — `tools control capture --help`")
    .allowUnknownOption(true)
    .helpOption(false);

try {
    await runTool(program, { tool: "control" });
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exit(1);
}
