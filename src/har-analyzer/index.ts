#!/usr/bin/env bun
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
	.name("har-analyzer")
	.description("Token-efficient HAR file analyzer with reference system")
	.option("--format <type>", "Output format: md (default), json, toon", "md")
	.option("--full", "Show full output without references (bypass ref system)")
	.option("--include-all", "Include bodies of static assets (CSS, JS, images, fonts)")
	.option("--session <hash>", "Use a specific session (default: last loaded)")
	.option("-v, --verbose", "Verbose logging")
	.option("-i, --interactive", "Launch interactive mode");

// Import and register command modules
import { registerLoadCommand } from "./commands/load";
import { registerDashboardCommand } from "./commands/dashboard";
import { registerListCommand } from "./commands/list";
import { registerShowCommand, registerExpandCommand } from "./commands/show";
import { registerDomainsCommand, registerDomainCommand } from "./commands/domains";
import { registerSearchCommand } from "./commands/search";
import { registerHeadersCommand } from "./commands/headers";
import { registerWaterfallCommand } from "./commands/waterfall";
import { registerErrorsCommand } from "./commands/errors";
import { registerSecurityCommand } from "./commands/security";
import { registerSizeCommand } from "./commands/size";
import { registerRedirectsCommand } from "./commands/redirects";
import { registerCookiesCommand } from "./commands/cookies";
import { registerDiffCommand } from "./commands/diff";
import { registerExportCommand } from "./commands/export";
import { registerSessionsCommand } from "./commands/sessions";
import { registerMcpCommand } from "./commands/mcp";
registerLoadCommand(program);
registerDashboardCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerExpandCommand(program);
registerDomainsCommand(program);
registerDomainCommand(program);
registerSearchCommand(program);
registerHeadersCommand(program);
registerWaterfallCommand(program);
registerErrorsCommand(program);
registerSecurityCommand(program);
registerSizeCommand(program);
registerRedirectsCommand(program);
registerCookiesCommand(program);
registerDiffCommand(program);
registerExportCommand(program);
registerSessionsCommand(program);
registerMcpCommand(program);

// Default action: interactive mode or help
program.action(async (options) => {
	if (options.interactive || process.argv.length <= 2) {
		const { runInteractive } = await import("./interactive");
		await runInteractive(options);
	}
});

program.parse();
