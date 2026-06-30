#!/usr/bin/env bun
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { registerListCommand } from "./commands/list";
import { registerStatusCommand } from "./commands/status";
import { registerWatchCommand } from "./commands/watch";

const program = new Command();

program
    .name("agent-watch")
    .description("Notify when background agents finish, stall, or need you")
    .version("1.0.0")
    .showHelpAfterError(true);

registerWatchCommand(program);
registerStatusCommand(program);
registerListCommand(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "agent-watch" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("ExitPromptError") || message === "Cancelled") {
            process.exit(0);
        }

        logger.error({ error, tool: "agent-watch" }, "agent-watch failed");
        process.exit(1);
    }
}

main().catch((error) => {
    logger.error({ error, tool: "agent-watch" }, "agent-watch crashed unexpectedly");
    process.exit(1);
});
