#!/usr/bin/env bun

// src/timely/index.ts

import { Command } from "commander";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { enhanceHelp } from "@app/utils/cli";
import { TimelyApiClient } from "./api/client";
import { TimelyService } from "./api/service";

// Commands
import { registerLoginCommand } from "./commands/login";
import { registerLogoutCommand } from "./commands/logout";
import { registerStatusCommand } from "./commands/status";
import { registerAccountsCommand } from "./commands/accounts";
import { registerProjectsCommand } from "./commands/projects";
import { registerEventsCommand } from "./commands/events";
import { registerExportMonthCommand } from "./commands/export-month";
import { registerCacheCommand } from "./commands/cache";
import { registerMemoriesCommand } from "./commands/memories";

// Initialize shared dependencies
const storage = new Storage("timely");
const client = new TimelyApiClient(storage);
const service = new TimelyService(client, storage);

// Export dependencies for subcommands
export { storage, client, service };

function showHelpFull(): void {
    console.log(`
${chalk.bold("Timely CLI")} - Interact with Timely time tracking

${chalk.cyan("Usage:")}
  tools timely <command> [options]

${chalk.cyan("Commands:")}
  login                   Authenticate with Timely via OAuth2
  logout                  Clear stored authentication tokens
  status                  Show current configuration and auth status
  accounts                List all accounts (--select to choose default)
  projects                List all projects (--select to choose default)
  events                  List time entries (with memories + unlinked by default)
  memories                List auto-tracked activities (suggested entries)
  export-month <YYYY-MM>  Export all entries for a month
  cache [list|clear]      Manage cache

${chalk.cyan("Global Options:")}
  -?, --help-full         Show this help message
  -v, --verbose           Enable verbose output
  -f, --format <format>   Output format: json, table, csv, raw, summary, detailed-summary (default: table)
  -a, --account <id>      Override account ID
  -p, --project <id>      Override project ID
  --silent, --quiet        Suppress console output (only show file path)

${chalk.cyan("Date Options (for events/memories commands):")}
  --since <YYYY-MM-DD>    Start date
  --upto <YYYY-MM-DD>     End date
  --day <YYYY-MM-DD>      Single day

${chalk.cyan("Examples:")}
  tools timely login
  tools timely accounts --select
  tools timely projects
  tools timely events --since 2025-11-01 --upto 2025-11-30
  tools timely export-month 2025-11
  tools timely export-month 2025-11 --format csv > time.csv
  tools timely export-month 2025-11 --format raw  # Detailed table with all info
  tools timely export-month 2025-11 --format summary  # Generate summary markdown
  tools timely export-month 2025-11 --format detailed-summary --silent  # Detailed summary, only show path
  tools timely cache clear
`);
}

async function main(): Promise<void> {
    // Ensure storage directories exist
    await storage.ensureDirs();

    const program = new Command()
        .name("timely")
        .description("Timely time tracking CLI")
        .option("-?, --help-full", "Show detailed help message")
        .helpCommand(true)
        .action((options) => {
            if (options.helpFull) {
                showHelpFull();
                process.exit(0);
            }
            // Show help when no subcommand given
            showHelpFull();
            process.exit(0);
        });

    // Register all subcommands
    registerLoginCommand(program, storage, client);
    registerLogoutCommand(program, storage);
    registerStatusCommand(program, storage, client);
    registerAccountsCommand(program, storage, service);
    registerProjectsCommand(program, storage, service);
    registerEventsCommand(program, storage, service);
    registerExportMonthCommand(program, storage, service);
    registerCacheCommand(program, storage);
    registerMemoriesCommand(program, storage, service);
    enhanceHelp(program);

    // Parse and execute
    await program.parseAsync(process.argv);
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
