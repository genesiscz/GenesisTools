import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { registerSpendCommand } from "./lib/register";

const program = new Command();

program.name("ai-spend").description("Claude Code token & cost analytics across all local sessions");

registerSpendCommand(program);

await runTool(program, { tool: "ai-spend" });
