#!/usr/bin/env bun

import { registerAgentTool } from "@app/ai/commands/agent/register";
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { grokSpec } from "./lib/spec";

const program = new Command();

program.name("grok").description(grokSpec.description);
registerAgentTool(program, grokSpec);

await runTool(program, { tool: "grok" });
