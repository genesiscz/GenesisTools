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
import { registerCaptureCommands } from "./commands/capture";
import { registerCompareScreenshotCommand } from "./commands/compare-screenshot";
import { registerCursorCommands } from "./commands/cursor";
import { registerDiscoveryCommands } from "./commands/discovery";
import { registerDrawCommand } from "./commands/draw";
import { registerInteractCommands } from "./commands/interact";
import { registerRecordPlanCommand } from "./commands/record-plan";
import { registerRunCommand } from "./commands/run";
import { registerStateCommands } from "./commands/state";
import { registerVerifyCommands } from "./commands/verify";
import { registerWorkflowCommands } from "./commands/workflow";

const program = new Command();

program
    .name("control")
    .description(
        "macOS UI automation — element control via the Accessibility API, plus screen recording with timed actions (capture).\nStart with `control see --app <name>` for indexed snapshot inspection and `control act` for validated actions. Use `control preflight --app <name>` for legacy discovery and recording plans.\nDiscover valid --app values with `control apps`."
    )
    .version("1.0.0");

registerCaptureCommands(program);
registerCompareScreenshotCommand(program);
registerCursorCommands(program);
registerDiscoveryCommands(program);
registerDrawCommand(program);
registerInteractCommands(program);
registerRecordPlanCommand(program);
registerRunCommand(program);
registerStateCommands(program);
registerVerifyCommands(program);
registerWorkflowCommands(program);

try {
    await runTool(program, { tool: "control" });
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exit(1);
}
