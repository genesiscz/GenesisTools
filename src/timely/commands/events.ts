import { Command } from "commander";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "@app/timely/api/service";
import { formatDuration } from "@app/timely/utils/date";
import { fetchMemoriesForDates, buildSubEntryMap } from "@app/timely/utils/memories";
import type { TimelyEvent, TimelyEventSlim, TimelyEntry, OAuth2Tokens } from "@app/timely/types";

export function registerEventsCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("events")
        .description("List time entries")
        .option("-f, --format <format>", "Output format: json, table, csv", "table")
        .option("-a, --account <id>", "Override account ID")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--upto <date>", "End date (YYYY-MM-DD)")
        .option("--day <date>", "Single day (YYYY-MM-DD)")
        .option("--without-details", "Omit full raw event objects in JSON format")
        .option("--without-entries", "Skip fetching linked memories for each event")
        .option("-v, --verbose", "Show debug info (entry fetching, cache hits)")
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
    withoutDetails?: boolean;
    withoutEntries?: boolean;
    verbose?: boolean;
}

function slimEvent(event: TimelyEvent): TimelyEventSlim {
    const d = event.duration;
    const durationStr = `${String(d.hours).padStart(2, "0")}:${String(d.minutes).padStart(2, "0")}`;
    return {
        id: event.id,
        day: event.day,
        project: { id: event.project?.id ?? 0, name: event.project?.name ?? "No Project" },
        duration: durationStr,
        note: event.note,
        from: event.from || null,
        to: event.to || null,
        entry_ids: event.entry_ids ?? [],
        billed: event.billed,
        billable: event.billable,
        cost: event.cost?.amount ?? 0,
    };
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

    // Fetch linked memories if requested
    if (!options.withoutEntries) {
        const tokens = await storage.getConfigValue<OAuth2Tokens>("tokens");
        if (!tokens?.access_token) {
            logger.error("Not authenticated. Run 'tools timely login' first.");
            process.exit(1);
        }

        const dates = [...new Set(events.map((e) => e.day))];
        const verbose = options.verbose;

        const result = await fetchMemoriesForDates({
            accountId,
            accessToken: tokens.access_token,
            dates,
            storage,
            verbose,
        });

        const subEntryToMemory = buildSubEntryMap(result.entries);
        if (verbose) logger.info(chalk.dim(`[entries] Built map: ${subEntryToMemory.size} sub-entry IDs`));

        // Match event entry_ids to memories (deduplicated)
        let matchedCount = 0;
        let unmatchedCount = 0;
        for (const event of events) {
            if (event.entry_ids && event.entry_ids.length > 0) {
                const seen = new Set<string>();
                const matched: TimelyEntry[] = [];
                for (const entryId of event.entry_ids) {
                    const memory = subEntryToMemory.get(entryId);
                    if (memory) {
                        const key = `${memory.title}|${memory.note || ""}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            matched.push(memory);
                        }
                    }
                }
                (event as TimelyEvent & { entries?: TimelyEntry[] }).entries = matched;
                if (matched.length > 0) matchedCount++;
                else unmatchedCount++;
            }
        }

        if (verbose) logger.info(chalk.dim(`[entries] Matched: ${matchedCount} events, unmatched: ${unmatchedCount}`));
    }

    // Output based on format
    if (options.format === "json") {
        if (!options.withoutDetails) {
            console.log(JSON.stringify(events, null, 2));
        } else {
            const slim = events.map((e) => {
                const s = slimEvent(e);
                const entries = (e as TimelyEvent & { entries?: TimelyEntry[] }).entries;
                if (!options.withoutEntries && entries) {
                    s.entries = entries.map((ent) => {
                        const slim: Record<string, unknown> = {
                            title: ent.title,
                            note: ent.note || "",
                            duration: { formatted: ent.duration.formatted },
                        };
                        // Sub-entries: API returns "entries" on suggested_entries, type uses "sub_entries"
                        const subs = ent.sub_entries || (ent as unknown as Record<string, unknown>).entries as typeof ent.sub_entries;
                        if (subs && subs.length > 0) {
                            slim.sub_entries = subs.map((sub) => ({
                                note: sub.note || "",
                                duration: { formatted: sub.duration.formatted },
                            }));
                        }
                        return slim;
                    }) as unknown as TimelyEntry[];
                }
                return s;
            });
            console.log(JSON.stringify(slim, null, 2));
        }
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

        // Calculate dynamic project column width
        const maxProjectLen = Math.min(
            20,
            Math.max(7, ...dayEvents.map((e) => (e.project?.name || "No Project").length))
        );

        if (!options.withoutEntries) {
            for (const event of dayEvents) {
                const project = (event.project?.name || "No Project").padEnd(maxProjectLen);
                const note = event.note ? ` ${chalk.dim(event.note)}` : "";
                const fromTo = event.from && event.to ? chalk.dim(` ${event.from}-${event.to}`) : "";
                console.log(`  ${chalk.bold(event.duration.formatted.padStart(5))} ${chalk.yellow(project)}${note}${fromTo}`);

                const entries = (event as TimelyEvent & { entries?: TimelyEntry[] }).entries;
                if (entries && entries.length > 0) {
                    for (const ent of entries) {
                        console.log(`  ${" ".repeat(5)} ${chalk.cyan(ent.title.padEnd(maxProjectLen))} ${chalk.dim(ent.duration.formatted)}`);
                        // Sub-entries: API uses "entries", type uses "sub_entries"
                        const subs = ent.sub_entries || (ent as unknown as Record<string, unknown>).entries as typeof ent.sub_entries;
                        if (subs && subs.length > 0) {
                            for (const sub of subs) {
                                if (sub.note) {
                                    const shortNote = sub.note.length > 60 ? sub.note.substring(0, 58) + ".." : sub.note;
                                    console.log(`  ${" ".repeat(5)} ${" ".repeat(maxProjectLen)} ${chalk.dim(`${sub.duration.formatted} ${shortNote}`)}`);
                                }
                            }
                        }
                    }
                }
            }
        } else {
            for (const event of dayEvents) {
                const project = (event.project?.name || "No Project").padEnd(maxProjectLen);
                const note = event.note || "";
                console.log(`  ${event.duration.formatted.padStart(5)} ${project} ${note}`);
            }
        }
        console.log();
    }

    // Summary
    console.log(chalk.cyan("─".repeat(60)));
    console.log(chalk.bold(`Total: ${formatDuration(totalSeconds)}`));
    console.log(`Events: ${events.length}`);
    console.log(`Days: ${sortedDays.length}`);
}
