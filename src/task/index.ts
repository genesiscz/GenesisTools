#!/usr/bin/env bun

import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { registerCleanCommand } from "@app/task/commands/clean";
import { registerDashboardCommand } from "@app/task/commands/dashboard";
import { registerGetCommand } from "@app/task/commands/get";
import { registerLogsCommand } from "@app/task/commands/logs";
import { registerRunCommand } from "@app/task/commands/run";
import { registerSessionsCommand } from "@app/task/commands/sessions";
import { registerTailCommand } from "@app/task/commands/tail";

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
