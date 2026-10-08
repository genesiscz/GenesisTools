#!/usr/bin/env bun

import { registerSessionQueueCommand } from "@app/ai/commands/agent/queue";
import { registerAgentTool } from "@app/ai/commands/agent/register";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { grokSpec } from "./lib/spec";

const program = new Command();

program.name("grok").description(grokSpec.description);
registerAgentTool(program, grokSpec);
registerSessionQueueCommand({ program, provider: "grok" });

await runTool(program, { tool: "grok" });
