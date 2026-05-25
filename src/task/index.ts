#!/usr/bin/env bun

import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { registerCleanCommand } from "./commands/clean";
import { registerDashboardCommand } from "./commands/dashboard";
import { registerGetCommand } from "./commands/get";
import { registerLogsCommand } from "./commands/logs";
import { registerRunCommand } from "./commands/run";
import { registerSessionsCommand } from "./commands/sessions";
import { registerTailCommand } from "./commands/tail";

const program = new Command();

program
    .name("task")
    .description("PTY-aware command wrapper with ordered log capture for agents")
    .option("--session <name>", "Session name (fuzzy-matched)")
    .option("-v, --verbose", "Verbose logging");

registerRunCommand(program);
registerGetCommand(program);
registerLogsCommand(program);
registerTailCommand(program);
registerSessionsCommand(program);
registerCleanCommand(program);
registerDashboardCommand(program);

await runTool(program, { tool: "task" });
