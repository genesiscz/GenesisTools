#!/usr/bin/env bun

import { registerAgentResumeCommand, registerAgentRunCommand } from "@app/ai/commands/agent/run";
import { registerAgentWhoCommand } from "@app/ai/commands/agent/who";
import { registerWorkerVerbs } from "@app/ai/commands/agent/worker";
import { registerProviderUsageCommand } from "@app/ai/commands/usage/provider-usage";
import { registerWarmupCommand } from "@app/ai/commands/warmup";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerGrokHistoryCommand } from "./commands/history";
import { registerGrokLoginCommand } from "./commands/login";
import { grokDriver } from "./lib/driver";
import { classifyGrokArgs } from "./lib/process-scan";
import { grokSpec } from "./lib/spec";

const program = new Command();

program.name("grok").description(grokSpec.description);

registerAgentRunCommand(program, grokSpec);
registerAgentResumeCommand(program, grokSpec);
registerWorkerVerbs(program, grokDriver, { tool: "tools grok", subcommand: [] });
registerAgentWhoCommand(program, { alias: "grok", tool: "tools grok", classify: classifyGrokArgs });

registerGrokHistoryCommand(program);
registerGrokLoginCommand(program);
registerWarmupCommand(program, { provider: "grok-sub", tool: "tools grok warmup" });
registerProviderUsageCommand(program, {
    provider: "grok-sub",
    tool: "tools grok usage",
    // xAI reports one monthly billing credit rather than percentage windows.
    description: "Grok monthly billing credit (interactive TUI)",
});

await runTool(program, { tool: "grok" });
