#!/usr/bin/env bun

// src/timely/index.ts

import minimist from "minimist";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "./api/client";
import { TimelyService } from "./api/service";
import type { TimelyArgs } from "./types";

// Commands
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { statusCommand } from "./commands/status";
import { accountsCommand } from "./commands/accounts";
import { projectsCommand } from "./commands/projects";
import { eventsCommand } from "./commands/events";
import { exportMonthCommand } from "./commands/export-month";
import { cacheCommand } from "./commands/cache";

type CommandHandler = (
    args: TimelyArgs,
    storage: Storage,
    client: TimelyApiClient,
    service: TimelyService
) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
    login: async (args, storage, client) => {
        await loginCommand(args, storage, client);
    },
    logout: async (args, storage) => {
        await logoutCommand(args, storage);
    },
    status: async (args, storage, client) => {
        await statusCommand(args, storage, client);
    },
    accounts: async (args, storage, client, service) => {
        await accountsCommand(args, storage, service);
    },
    projects: async (args, storage, client, service) => {
        await projectsCommand(args, storage, service);
    },
    events: async (args, storage, client, service) => {
        await eventsCommand(args, storage, service);
    },
    "export-month": async (args, storage, client, service) => {
        await exportMonthCommand(args, storage, service);
    },
    cache: async (args, storage) => {
        await cacheCommand(args, storage);
    },
};

function showHelp(): void {
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
  events                  List time entries
  export-month <YYYY-MM>  Export all entries for a month
  cache [list|clear]      Manage cache

${chalk.cyan("Global Options:")}
  -h, --help              Show this help message
  -v, --verbose           Enable verbose output
  -f, --format <format>   Output format: json, table, csv, raw, summary, detailed-summary (default: table)
  -a, --account <id>      Override account ID
  -p, --project <id>      Override project ID
  --silent, --quiet        Suppress console output (only show file path)

${chalk.cyan("Date Options (for events command):")}
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
    const args = minimist<TimelyArgs>(process.argv.slice(2), {
        alias: {
            h: "help",
            v: "verbose",
            f: "format",
            a: "account",
            p: "project",
        },
        boolean: ["help", "verbose", "select", "clipboard", "silent", "quiet"],
        string: ["format", "since", "upto", "day", "month", "output"],
    });

    // Convert account and project to numbers if provided
    if (args.account) {
        args.account = typeof args.account === "string" ? parseInt(args.account, 10) : args.account;
    }
    if (args.project) {
        args.project = typeof args.project === "string" ? parseInt(args.project, 10) : args.project;
    }

    // Show help if requested or no command
    if (args.help || args._.length === 0) {
        showHelp();
        process.exit(0);
    }

    const command = args._[0];

    // Check if command exists
    if (!(command in COMMANDS)) {
        logger.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }

    // Initialize storage, client, and service
    const storage = new Storage("timely");
    await storage.ensureDirs();

    const client = new TimelyApiClient(storage);
    const service = new TimelyService(client, storage);

    // Execute command
    try {
        await COMMANDS[command](args, storage, client, service);
    } catch (error) {
        if (error instanceof Error && (error.message === "canceled" || error.message === "")) {
            logger.info("\nOperation cancelled.");
            process.exit(0);
        }
        logger.error(`Command failed: ${error}`);
        if (args.verbose) {
            console.error(error);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
