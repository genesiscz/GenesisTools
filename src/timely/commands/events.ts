import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import { formatDuration } from "../utils/date";
import type { TimelyArgs, TimelyEvent } from "../types";

export async function eventsCommand(args: TimelyArgs, storage: Storage, service: TimelyService): Promise<void> {
    // Get account ID
    const accountId = args.account || (await storage.getConfigValue<number>("selectedAccountId"));
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    // Build params from args
    const params: { since?: string; upto?: string; day?: string } = {};
    if (args.since) params.since = args.since;
    if (args.upto) params.upto = args.upto;
    if (args.day) params.day = args.day;

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
    if (args.format === "json") {
        console.log(JSON.stringify(events, null, 2));
        return;
    }

    if (args.format === "csv") {
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
