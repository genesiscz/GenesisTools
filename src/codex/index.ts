#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerApprovalCommands } from "./commands/approve";
import { registerInterruptCommand } from "./commands/interrupt";
import { registerCodexLoginCommand } from "./commands/login";
import { registerLogsCommand } from "./commands/logs";
import { registerReadCommand } from "./commands/read";
import { registerReviewCommand } from "./commands/review";
import { registerRollbackCommand } from "./commands/rollback";
import { registerSessionsCommand } from "./commands/sessions";
import { registerSpawnCommand } from "./commands/spawn";
import { registerStatusCommand } from "./commands/status";
import { registerSteerCommand } from "./commands/steer";
import { registerStopCommand } from "./commands/stop";
import { registerTailCommand } from "./commands/tail";
import { registerUsageCommand } from "./commands/usage";

const program = new Command();

program.name("codex").description("Spawn, monitor, and steer Codex app-server sessions");

registerCodexLoginCommand(program);
registerSpawnCommand(program);
registerSteerCommand(program);
registerInterruptCommand(program);
registerRollbackCommand(program);
registerReadCommand(program);
registerReviewCommand(program);
registerApprovalCommands(program);
registerStatusCommand(program);
registerSessionsCommand(program);
registerLogsCommand(program);
registerTailCommand(program);
registerStopCommand(program);
registerUsageCommand(program);

await runTool(program, { tool: "codex" });
