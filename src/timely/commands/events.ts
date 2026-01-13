import { Command } from "commander";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import { formatDuration } from "../utils/date";
import type { TimelyEvent } from "../types";

export function registerEventsCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("events")
        .description("List time entries")
        .option("-f, --format <format>", "Output format: json, table, csv", "table")
        .option("-a, --account <id>", "Override account ID")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--upto <date>", "End date (YYYY-MM-DD)")
        .option("--day <date>", "Single day (YYYY-MM-DD)")
        .action(async (options) => {
            await eventsAction(storage, service, options);
        });
}

interface EventsOptions {
    format?: string;
    account?: string;
    since?: string;
    upto?: string;
    day?: string;
}

async function eventsAction(storage: Storage, service: TimelyService, options: EventsOptions): Promise<void> {
    // Get account ID
    const accountId = options.account
        ? parseInt(options.account, 10)
        : await storage.getConfigValue<number>("selectedAccountId");
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    // Build params from args
    const params: { since?: string; upto?: string; day?: string } = {};
    if (options.since) params.since = options.since;
    if (options.upto) params.upto = options.upto;
    if (options.day) params.day = options.day;

    if (!params.since && !params.upto && !params.day) {
        logger.error("Please provide at least one date filter: --since, --upto, or --day");
        logger.info("Example: tools timely events --since 2025-11-01 --upto 2025-11-30");
        process.exit(1);
    }

    logger.info(chalk.yellow("Fetching events..."));
    const events = await service.getAllEvents(accountId, params);

    if (events.length === 0) {
        logger.info("No events found.");
        return;
    }

    // Output based on format
    if (options.format === "json") {
        console.log(JSON.stringify(events, null, 2));
        return;
    }

    if (options.format === "csv") {
        // CSV output
        console.log("date,project,note,hours,minutes,duration_formatted");
        for (const event of events) {
            console.log(
                [
                    event.day,
                    `"${event.project?.name || "No Project"}"`,
                    `"${event.note.replace(/"/g, '""')}"`,
                    event.duration.hours,
                    event.duration.minutes,
                    event.duration.formatted,
                ].join(",")
            );
        }
        return;
    }

    // Table output (default)
    logger.info(chalk.cyan(`\nFound ${events.length} event(s):\n`));

    // Group by day
    const byDay = new Map<string, TimelyEvent[]>();
    for (const event of events) {
        if (!byDay.has(event.day)) {
            byDay.set(event.day, []);
        }
        byDay.get(event.day)!.push(event);
    }

    // Sort days
    const sortedDays = Array.from(byDay.keys()).sort();

    let totalSeconds = 0;

    for (const day of sortedDays) {
        const dayEvents = byDay.get(day)!;
        const dayTotal = dayEvents.reduce((sum, e) => sum + e.duration.total_seconds, 0);
        totalSeconds += dayTotal;

        console.log(chalk.bold(`${day} (${formatDuration(dayTotal)})`));

        for (const event of dayEvents) {
            const project = event.project?.name || "No Project";
            const note = event.note.substring(0, 50) + (event.note.length > 50 ? "..." : "");
            console.log(`  ${event.duration.formatted.padStart(8)} | ${project.padEnd(20)} | ${note}`);
        }
        console.log();
    }

    // Summary
    console.log(chalk.cyan("─".repeat(60)));
    console.log(chalk.bold(`Total: ${formatDuration(totalSeconds)}`));
    console.log(`Events: ${events.length}`);
    console.log(`Days: ${sortedDays.length}`);
}
