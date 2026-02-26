import logger from "@app/logger";
import type { TimelyService } from "@app/timely/api/service";
import type { TimelyEvent } from "@app/timely/types";
import { formatDuration, getDatesInMonth, getMonthDateRange } from "@app/timely/utils/date";
import { generateReportMarkdown } from "@app/timely/utils/entry-processor";
import type { Storage } from "@app/utils/storage";
import chalk from "chalk";
import Table from "cli-table3";
import type { Command } from "commander";

export function registerExportMonthCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("export-month")
        .description("Export all entries for a month")
        .argument("<month>", "Month in YYYY-MM format")
        .option("-f, --format <format>", "Output format: json, csv, raw, table, summary, detailed-summary", "table")
        .option("-a, --account <id>", "Override account ID")
        .option("-s, --silent", "Suppress console output (only show file path)")
        .option("-q, --quiet", "Alias for --silent")
        .action(async (month, options) => {
            await exportMonthAction(storage, service, month, options);
        });
}

interface ExportMonthOptions {
    format?: string;
    account?: string;
    silent?: boolean;
    quiet?: boolean;
}

async function exportMonthAction(
    storage: Storage,
    service: TimelyService,
    monthArg: string,
    options: ExportMonthOptions
): Promise<void> {
    // Parse month argument (YYYY-MM)
    if (!monthArg || !/^\d{4}-\d{2}$/.test(monthArg)) {
        logger.error("Please provide a month in YYYY-MM format.");
        logger.info("Example: tools timely export-month 2025-11");
        process.exit(1);
    }

    // Get account ID
    const accountId = options.account
        ? parseInt(options.account, 10)
        : await storage.getConfigValue<number>("selectedAccountId");
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    // Download suggested_entries.json for all dates in the month
    const tokens = await storage.getConfigValue<{ access_token: string }>("tokens");
    if (!tokens?.access_token) {
        logger.error("No access token found. Run 'tools timely login' first.");
        process.exit(1);
    }

    const dates = getDatesInMonth(monthArg);
    const today = new Date().toISOString().split("T")[0];

    logger.info(chalk.yellow(`Downloading suggested_entries.json for ${dates.length} date(s) in ${monthArg}...`));

    for (const date of dates) {
        const cacheKey = `suggested_entries/suggested_entries-${date}.json`;
        const isToday = date === today;
        // Today's date expires in 1 hour, all other dates never expire (3650000 days = ~10000 years)
        const ttl = isToday ? "1 hour" : "3650000 days";

        try {
            await storage.getFileOrPut(
                cacheKey,
                async () => {
                    const url = `https://app.timelyapp.com/${accountId}/suggested_entries.json?date=${date}&spam=true`;
                    logger.debug(`[suggested_entries] Fetching ${date}...`);

                    const response = await fetch(url, {
                        method: "GET",
                        headers: {
                            accept: "application/json",
                            "content-type": "application/json",
                            Authorization: `Bearer ${tokens.access_token}`,
                        },
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.debug(
                            `[suggested_entries] Failed for ${date}: ${response.status} ${response.statusText}`
                        );
                        throw new Error(
                            `Failed to fetch suggested_entries for ${date}: ${response.status} ${errorText}`
                        );
                    }

                    const data = await response.json();
                    logger.debug(
                        `[suggested_entries] Success for ${date}: ${
                            Array.isArray(data) ? `array[${data.length}]` : typeof data
                        }`
                    );
                    return data;
                },
                ttl
            );
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to download suggested_entries for ${date}: ${errorMessage}`);
            // Continue with other dates even if one fails
        }
    }

    // Calculate date range
    const { since, upto } = getMonthDateRange(monthArg);
    logger.info(chalk.yellow(`Fetching events for ${monthArg} (${since} to ${upto})...`));

    // Use caching with TTL
    const cacheKey = `events/${accountId}/${monthArg}.json`;

    // Use shorter TTL for current/recent months
    const currentMonth = new Date().toISOString().substring(0, 7);
    const ttl = monthArg === currentMonth ? "1 hour" : "7 days";

    const events = await storage.getFileOrPut<TimelyEvent[]>(
        cacheKey,
        () => service.getAllEvents(accountId, { since, upto }),
        ttl
    );

    if (events.length === 0) {
        logger.info("No events found for this month.");
        return;
    }

    // Output based on format
    const format = options.format || "table";
    const silent = options.silent || options.quiet || false;

    switch (format) {
        case "json":
            exportAsJson(events);
            break;
        case "csv":
            exportAsCsv(events);
            break;
        case "raw":
            await exportAsRaw(events, monthArg, accountId, tokens.access_token, service);
            break;
        case "summary":
            await exportAsReport(monthArg, storage, silent, false);
            break;
        case "detailed-summary":
            await exportAsReport(monthArg, storage, silent, true);
            break;
        default:
            exportAsTable(events, monthArg);
            break;
    }
}

/**
 * Export events as JSON format
 */
function exportAsJson(events: TimelyEvent[]): void {
    console.log(JSON.stringify(events, null, 2));
}

/**
 * Export events as CSV format
 */
function exportAsCsv(events: TimelyEvent[]): void {
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
}

/**
 * Export events as detailed raw table format with all information
 */
async function exportAsRaw(
    events: TimelyEvent[],
    monthArg: string,
    accountId: number,
    accessToken: string,
    service: TimelyService
): Promise<void> {
    logger.info(chalk.cyan(`\nFound ${events.length} event(s) for ${monthArg}:\n`));

    // Group by day
    const byDay = new Map<string, TimelyEvent[]>();
    for (const event of events) {
        if (!byDay.has(event.day)) {
            byDay.set(event.day, []);
        }
        byDay.get(event.day)?.push(event);
    }

    // Sort days
    const sortedDays = Array.from(byDay.keys()).sort();

    let totalSeconds = 0;

    for (const day of sortedDays) {
        const dayEvents = byDay.get(day)!;
        const dayTotal = dayEvents.reduce((sum, e) => sum + e.duration.total_seconds, 0);
        totalSeconds += dayTotal;

        console.log(chalk.bold.cyan(`\n${"=".repeat(100)}`));
        console.log(chalk.bold.cyan(`${day} - Total: ${formatDuration(dayTotal)}`));
        console.log(chalk.bold.cyan(`${"=".repeat(100)}\n`));

        // Create detailed table for each event
        for (const event of dayEvents) {
            const table = new Table({
                style: { head: ["cyan"], border: ["gray"] },
                colWidths: [25, 75],
            });

            // Basic Information
            table.push([chalk.bold("ID"), event.id.toString()]);
            table.push([chalk.bold("UID"), event.uid]);
            table.push([chalk.bold("Day"), event.day]);
            table.push([chalk.bold("Sequence"), event.sequence.toString()]);

            // Duration Information
            table.push([chalk.bold("Duration"), ""]);
            table.push(["  Hours", event.duration.hours.toString()]);
            table.push(["  Minutes", event.duration.minutes.toString()]);
            table.push(["  Seconds", event.duration.seconds.toString()]);
            table.push(["  Total Hours", event.duration.total_hours.toFixed(2)]);
            table.push(["  Total Minutes", event.duration.total_minutes.toString()]);
            table.push(["  Total Seconds", event.duration.total_seconds.toString()]);
            table.push(["  Formatted", event.duration.formatted]);

            // Estimated Duration (if available)
            if (event.estimated_duration) {
                table.push([chalk.bold("Estimated Duration"), ""]);
                table.push(["  Hours", event.estimated_duration.hours.toString()]);
                table.push(["  Minutes", event.estimated_duration.minutes.toString()]);
                table.push(["  Formatted", event.estimated_duration.formatted]);
            }

            // Time Range
            if (event.from && event.to) {
                table.push([chalk.bold("Time Range"), `${event.from} - ${event.to}`]);
            }

            // Project Information
            table.push([chalk.bold("Project"), ""]);
            table.push(["  ID", event.project?.id?.toString() || "N/A"]);
            table.push(["  Name", event.project?.name || "No Project"]);
            table.push(["  Active", event.project?.active ? "Yes" : "No"]);
            table.push(["  Billable", event.project?.billable ? "Yes" : "No"]);
            if (event.project?.client) {
                table.push(["  Client", event.project.client.name]);
            }
            if (event.project?.description) {
                table.push(["  Description", event.project.description]);
            }

            // User Information
            table.push([chalk.bold("User"), ""]);
            table.push(["  ID", event.user?.id?.toString() || "N/A"]);
            table.push(["  Name", event.user?.name || "N/A"]);
            table.push(["  Email", event.user?.email || "N/A"]);

            // Note (full text, not truncated)
            table.push([chalk.bold("Note"), event.note || "(no note)"]);

            // Cost Information
            if (event.cost) {
                table.push([chalk.bold("Cost"), ""]);
                table.push(["  Amount", event.cost.amount.toString()]);
                table.push(["  Formatted", event.cost.formatted]);
                table.push(["  Currency", event.cost.currency_code]);
            }

            // Estimated Cost (if available)
            if (event.estimated_cost) {
                table.push([chalk.bold("Estimated Cost"), ""]);
                table.push(["  Amount", event.estimated_cost.amount.toString()]);
                table.push(["  Formatted", event.estimated_cost.formatted]);
            }

            // Hour Rate
            table.push([chalk.bold("Hour Rate"), ""]);
            table.push(["  Rate", event.hour_rate?.toString() || "N/A"]);
            table.push(["  Rate (cents)", event.hour_rate_in_cents?.toString() || "N/A"]);

            // Status Flags
            table.push([chalk.bold("Status"), ""]);
            table.push(["  Estimated", event.estimated ? "Yes" : "No"]);
            table.push(["  Billable", event.billable ? "Yes" : "No"]);
            table.push(["  Billed", event.billed ? "Yes" : "No"]);
            table.push(["  Draft", event.draft ? "Yes" : "No"]);
            table.push(["  Deleted", event.deleted ? "Yes" : "No"]);
            table.push(["  Locked", event.locked ? "Yes" : "No"]);
            if (event.locked_reason) {
                table.push(["  Locked Reason", event.locked_reason]);
            }

            // Timer Information
            if (event.timer_state) {
                table.push([chalk.bold("Timer"), ""]);
                table.push(["  State", event.timer_state]);
                if (event.timer_started_on) {
                    table.push(["  Started", new Date(event.timer_started_on * 1000).toISOString()]);
                }
                if (event.timer_stopped_on) {
                    table.push(["  Stopped", new Date(event.timer_stopped_on * 1000).toISOString()]);
                }
            }

            // Labels
            if (event.label_ids && event.label_ids.length > 0) {
                table.push([chalk.bold("Label IDs"), event.label_ids.join(", ")]);
            }

            // User IDs
            if (event.user_ids && event.user_ids.length > 0) {
                table.push([chalk.bold("User IDs"), event.user_ids.join(", ")]);
            }

            // External ID
            if (event.external_id) {
                table.push([chalk.bold("External ID"), event.external_id]);
            }

            // Suggestion ID
            if (event.suggestion_id) {
                table.push([chalk.bold("Suggestion ID"), event.suggestion_id.toString()]);
            }

            // Invoice ID
            if (event.invoice_id) {
                table.push([chalk.bold("Invoice ID"), event.invoice_id.toString()]);
            }

            // Forecast ID
            if (event.forecast_id) {
                table.push([chalk.bold("Forecast ID"), event.forecast_id.toString()]);
            }

            // Entry IDs and Entry Data
            if (event.entry_ids && event.entry_ids.length > 0) {
                table.push([chalk.bold("Entry IDs"), event.entry_ids.join(", ")]);

                // Fetch and display entry details
                logger.debug(`Fetching ${event.entry_ids.length} entry/entries for event ${event.id}...`);
                for (const entryId of event.entry_ids) {
                    const entries = await service.getEntry(accountId, entryId, accessToken);
                    if (entries && Array.isArray(entries) && entries.length > 0) {
                        for (const entry of entries) {
                            table.push([chalk.bold(`Entry ${entryId} - ${entry.title}`), ""]);

                            // Display entry main info
                            table.push(["  Title", entry.title]);
                            table.push(["  Note", entry.note || "(no note)"]);
                            table.push(["  Duration", entry.duration.formatted]);
                            table.push(["  Date", entry.date]);
                            if (entry.from && entry.to) {
                                table.push(["  Time Range", `${entry.from} - ${entry.to}`]);
                            }

                            // Display sub-entries
                            if (entry.sub_entries && entry.sub_entries.length > 0) {
                                table.push([chalk.bold("  Sub-entries"), ""]);
                                for (const subEntry of entry.sub_entries) {
                                    table.push(["    Note", subEntry.note]);
                                    if (subEntry.from && subEntry.to) {
                                        table.push(["    Time", `${subEntry.from} - ${subEntry.to}`]);
                                    }
                                }
                            }
                        }
                    } else {
                        console.log(entries);
                        process.exit(1);
                        table.push([
                            chalk.bold(`Entry ${entryId}`),
                            chalk.gray("(Could not fetch entry data - entry may not exist or endpoint not available)"),
                        ]);
                    }
                }
            }

            // Timestamps
            table.push([chalk.bold("Timestamps"), ""]);
            table.push(["  Created At", new Date(event.created_at * 1000).toISOString()]);
            table.push(["  Updated At", new Date(event.updated_at * 1000).toISOString()]);
            if (event.billed_at) {
                table.push(["  Billed At", event.billed_at]);
            }

            // Source Information
            table.push([chalk.bold("Source"), ""]);
            table.push(["  Created From", event.created_from || "N/A"]);
            table.push(["  Updated From", event.updated_from || "N/A"]);

            // Creator/Updater IDs
            if (event.creator_id) {
                table.push([chalk.bold("Creator ID"), event.creator_id.toString()]);
            }
            if (event.updater_id) {
                table.push([chalk.bold("Updater ID"), event.updater_id.toString()]);
            }

            // State
            if (event.state) {
                table.push([chalk.bold("State"), event.state]);
            }

            // Manage flag
            table.push([chalk.bold("Manage"), event.manage ? "Yes" : "No"]);

            console.log(table.toString());
            console.log(); // Empty line between events
        }
    }

    // Summary
    console.log(chalk.bold.cyan(`\n${"=".repeat(100)}`));
    console.log(chalk.bold.cyan("SUMMARY"));
    console.log(chalk.bold.cyan(`${"=".repeat(100)}`));
    console.log(chalk.bold(`Total Duration: ${formatDuration(totalSeconds)}`));
    console.log(`Total Events: ${events.length}`);
    console.log(`Total Days: ${sortedDays.length}`);
    console.log();
}

/**
 * Export events as summary format
 * Uses the generic entry processor to generate a report markdown file
 * @param monthArg - Month in YYYY-MM format
 * @param storage - Storage instance
 * @param silent - Whether to suppress console output
 * @param detailMode - Whether to use detailed mode (for detailed-summary format)
 */
async function exportAsReport(
    monthArg: string,
    storage: Storage,
    silent: boolean,
    detailMode: boolean = false
): Promise<void> {
    if (!silent) {
        const modeText = detailMode ? "detailed " : "";
        logger.info(chalk.cyan(`\nGenerating ${modeText}summary for ${monthArg}...\n`));
    }

    const { content, filePath } = await generateReportMarkdown(monthArg, storage, detailMode);

    // Output absolute path (always shown)
    console.log(filePath);

    // Output content to console unless silent
    if (!silent) {
        console.log(content);
    }
}

/**
 * Export events as simple table format (default)
 */
function exportAsTable(events: TimelyEvent[], monthArg: string): void {
    logger.info(chalk.cyan(`\nFound ${events.length} event(s) for ${monthArg}:\n`));

    // Group by day
    const byDay = new Map<string, TimelyEvent[]>();
    for (const event of events) {
        if (!byDay.has(event.day)) {
            byDay.set(event.day, []);
        }
        byDay.get(event.day)?.push(event);
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
