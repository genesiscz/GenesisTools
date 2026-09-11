#!/usr/bin/env bun

import { registerWorkerVerbs } from "@app/ai/commands/agent/worker";
import { registerWarmupCommand } from "@app/ai/commands/warmup";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerApprovalCommands } from "./commands/approve";
import { registerCodexHistoryCommand } from "./commands/history";
import { registerCodexLoginCommand } from "./commands/login";
import { registerLogsCommand } from "./commands/logs";
import { registerMigrateHomeCommand } from "./commands/migrate-home";
import { registerReviewCommand } from "./commands/review";
import { registerRollbackCommand } from "./commands/rollback";
import { registerRunCommand } from "./commands/run";
import { registerUsageCommand } from "./commands/usage";
import { codexDriver } from "./lib/driver";

const program = new Command();

program.name("codex").description("Spawn, monitor, and steer Codex app-server sessions");

registerCodexLoginCommand(program);
registerWarmupCommand(program, { provider: "openai-sub", tool: "tools codex warmup" });
registerCodexHistoryCommand(program);
registerMigrateHomeCommand(program);
registerRunCommand(program);
registerWorkerVerbs(program, codexDriver, { tool: "tools codex", subcommand: [] });
registerRollbackCommand(program);
registerReviewCommand(program);
registerApprovalCommands(program);
registerLogsCommand(program);
registerUsageCommand(program);

await runTool(program, { tool: "codex" });
