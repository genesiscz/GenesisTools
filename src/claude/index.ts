#!/usr/bin/env bun
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { addGlobalVerboseOption } from "@app/utils/cli/commander";
import * as p from "@app/utils/prompts/p";
import { inquirerBackend } from "@app/utils/prompts/p/inquirer-backend";

// Use inquirer backend for this tool
p.setBackend(inquirerBackend);

import { Command } from "commander";
import { registerConfigCommand } from "./commands/config";
import { registerDaemonCommand } from "./commands/daemon";
import { registerDesktopCommand } from "./commands/desktop";
import { registerExportCommand } from "./commands/export";
import { registerHistoryCommand } from "./commands/history";
import { registerLoginLongCommand } from "./commands/login-long";
import { registerMcpCommand } from "./commands/mcp";
import { registerMemoryCommand } from "./commands/memory";
import { registerMigrateCommand } from "./commands/migrate";
import { registerResumeCommand } from "./commands/resume";
import { registerStartCommand } from "./commands/start";
import { registerSummarizeCommand } from "./commands/summarize";
import { registerTailCommand } from "./commands/tail";
import { registerUsageCommand } from "./commands/usage";
import { registerWarmupCommand } from "./commands/warmup";

const program = new Command();

program
    .name("claude")
    .description("Claude Code tools: history, resume, desktop sync, usage, config, migration")
    .version("1.0.0")
    .showHelpAfterError(true);

registerExportCommand(program);
registerHistoryCommand(program);
registerMemoryCommand(program);
registerSummarizeCommand(program);
registerResumeCommand(program);
registerTailCommand(program);
registerDesktopCommand(program);
registerUsageCommand(program);
registerConfigCommand(program);
registerDaemonCommand(program);
registerMigrateCommand(program);
registerWarmupCommand(program);
registerMcpCommand(program);
registerLoginLongCommand(program);
registerStartCommand(program);

addGlobalVerboseOption(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "claude" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ExitPromptError") || message === "Cancelled") {
            process.exit(0);
        }
        logger.error(`Error: ${message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
