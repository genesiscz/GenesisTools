#!/usr/bin/env bun
import logger from "@app/logger";
import { Command } from "commander";
import { registerHistoryCommand } from "./commands/history";
import { registerResumeCommand } from "./commands/resume";
import { registerDesktopCommand } from "./commands/desktop";
import { registerUsageCommand } from "./commands/usage";
import { registerConfigCommand } from "./commands/config";

const program = new Command();

program
	.name("claude")
	.description("Claude Code tools: history, resume, desktop sync, usage, config")
	.version("1.0.0")
	.showHelpAfterError(true);

registerHistoryCommand(program);
registerResumeCommand(program);
registerDesktopCommand(program);
registerUsageCommand(program);
registerConfigCommand(program);

async function main(): Promise<void> {
	try {
		await program.parseAsync(process.argv);
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
