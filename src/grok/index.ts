#!/usr/bin/env bun

import { registerAgentResumeCommand, registerAgentRunCommand } from "@app/ai/commands/agent/run";
import { registerWorkerVerbs } from "@app/ai/commands/agent/worker";
import { registerWarmupCommand } from "@app/ai/commands/warmup";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerGrokHistoryCommand } from "./commands/history";
import { registerGrokLoginCommand } from "./commands/login";
import { registerUsageCommand } from "./commands/usage";
import { grokDriver } from "./lib/driver";
import { grokSpec } from "./lib/spec";

const program = new Command();

program.name("grok").description(grokSpec.description);

registerAgentRunCommand(program, grokSpec);
registerAgentResumeCommand(program, grokSpec);
registerWorkerVerbs(program, grokDriver, { tool: "tools grok", subcommand: [] });

registerGrokHistoryCommand(program);
registerGrokLoginCommand(program);
registerWarmupCommand(program, { provider: "grok-sub", tool: "tools grok warmup" });
registerUsageCommand(program);

await runTool(program, { tool: "grok" });
