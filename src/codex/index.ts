#!/usr/bin/env bun

import { registerAgentWhoCommand } from "@app/ai/commands/agent/who";
import { registerWorkerVerbs } from "@app/ai/commands/agent/worker";
import { registerProviderUsageCommand } from "@app/ai/commands/usage/provider-usage";
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
import { codexDriver } from "./lib/driver";
import { CODEX_HELPER_KINDS, classifyCodexArgs } from "./lib/process-scan";

const program = new Command();

program.name("codex").description("Spawn, monitor, and steer Codex app-server sessions");

registerCodexLoginCommand(program);
registerWarmupCommand(program, { provider: "openai-sub", tool: "tools codex warmup" });
registerCodexHistoryCommand(program);
registerMigrateHomeCommand(program);
registerRunCommand(program);
registerWorkerVerbs(program, codexDriver, { tool: "tools codex", subcommand: [] });
registerAgentWhoCommand(program, {
    alias: "codex",
    tool: "tools codex",
    classify: classifyCodexArgs,
    helperKinds: CODEX_HELPER_KINDS,
});
registerRollbackCommand(program);
registerReviewCommand(program);
registerApprovalCommands(program);
registerLogsCommand(program);
registerProviderUsageCommand(program, {
    provider: "openai-sub",
    tool: "tools codex usage",
    // Codex has no presenter, so the Overview draws the two windows the app-server reports.
    description: "Codex rate-limit windows (interactive TUI)",
});

await runTool(program, { tool: "codex" });
