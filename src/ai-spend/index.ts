import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerSpendCommand } from "./lib/register";

const program = new Command();

program
    .name("ai-spend")
    .description(
        "Coding-agent token and cost analytics (ccusage-compatible daily/session/blocks plus summary/monitor)"
    );

registerSpendCommand(program);

await runTool(program, { tool: "ai-spend" });
