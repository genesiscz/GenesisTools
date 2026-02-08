import { Command, Option } from "commander";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "@app/timely/api/service";
import { formatDuration } from "@app/timely/utils/date";
import { fetchMemoriesForDates, buildSubEntryMap } from "@app/timely/utils/memories";
import { fuzzyMatchBest } from "@app/utils/fuzzy-match";
import type { FuzzyMatchResult } from "@app/utils/fuzzy-match";
import type { TimelyEvent, TimelyEventSlim, TimelyEntry, OAuth2Tokens } from "@app/timely/types";

export function registerEventsCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("events")
        .description("List time entries (with linked memories by default)")
        .option("-f, --format <format>", "Output format: json, table, csv", "table")
        .option("-a, --account <id>", "Override account ID")
        .option("--from <date>", "Start date (YYYY-MM-DD)")
        .option("--to <date>", "End date (YYYY-MM-DD)")
        .addOption(new Option("--since <date>").hideHelp())
        .addOption(new Option("--upto <date>").hideHelp())
        .option("--day <date>", "Single day (YYYY-MM-DD)")
        .option("--without-details", "Omit full raw event objects in JSON format")
        .option("--without-entries", "Skip fetching linked memories and unlinked analysis")
        .option("--force", "Bypass memory cache, fetch fresh from API")
        .option("-v, --verbose", "Show debug info (entry fetching, cache hits)")
        .action(async (options) => {
            await eventsAction(storage, service, options);
        });
}

interface EventsOptions {
    format?: string;
    account?: string;
    from?: string;
    to?: string;
    since?: string;
    upto?: string;
    day?: string;
    withoutDetails?: boolean;
    withoutEntries?: boolean;
    force?: boolean;
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

/** Extract "HH:MM" from ISO datetime or pass through "HH:MM" */
function extractHHMM(time: string): string | null {
    const m = time.match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : null;
}

/** Get sub-entries from a memory (API uses "entries" field, TS type uses "sub_entries") */
function getSubEntries(entry: TimelyEntry): typeof entry.sub_entries {
    return entry.sub_entries
        || (entry as unknown as Record<string, unknown>).entries as typeof entry.sub_entries
        || [];
}

type UnlinkedMemory = TimelyEntry & { suggestedMatch?: FuzzyMatchResult };

interface UnlinkedMemorySlim {
    day: string;
    title: string;
    note: string;
    duration: string;
    from: string | null;
    to: string | null;
    suggested_event?: { id: number; score: number; reasons: string[] };
    sub_entries?: Array<{ note: string; duration: string }>;
}

async function eventsAction(storage: Storage, service: TimelyService, options: EventsOptions): Promise<void> {
    const accountId = options.account
        ? parseInt(options.account, 10)
        : await storage.getConfigValue<number>("selectedAccountId");
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    const from = options.from || options.since;
    const to = options.to || options.upto;

    const params: { since?: string; upto?: string; day?: string } = {};
    if (from) params.since = from;
    if (to) params.upto = to;
    if (options.day) params.day = options.day;

    if (!from && !to && !options.day) {
        logger.error("Please provide at least one date filter: --from, --to, or --day");
        logger.info("Example: tools timely events --from 2025-11-01 --to 2025-11-30");
        process.exit(1);
    }

    logger.info(chalk.yellow("Fetching events..."));
    const events = await service.getAllEvents(accountId, params);

    if (events.length === 0) {
        logger.info("No events found.");
        return;
    }

    const fetchEntries = !options.withoutEntries;
    const unlinkedByDay = new Map<string, UnlinkedMemory[]>();

    if (fetchEntries) {
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
            force: options.force,
        });

        const subEntryToMemory = buildSubEntryMap(result.entries);
        if (verbose) logger.info(chalk.dim(`[entries] Built map: ${subEntryToMemory.size} sub-entry IDs`));

        // Match event entry_ids to memories (deduplicated)
        const linkedMemoryIds = new Set<number>();
        let matchedCount = 0;
        let unmatchedCount = 0;
        for (const event of events) {
            if (event.entry_ids && event.entry_ids.length > 0) {
                const seen = new Set<string>();
                const matched: TimelyEntry[] = [];
                for (const entryId of event.entry_ids) {
                    const memory = subEntryToMemory.get(entryId);
                    if (memory) {
                        linkedMemoryIds.add(memory.id);
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

        // Find unlinked memories per day and fuzzy match to events
        for (const [date, memories] of result.byDate) {
            const unlinked = memories.filter((m) => !linkedMemoryIds.has(m.id));
            if (unlinked.length === 0) continue;

            const dayEvents = events.filter((e) => e.day === date);
            const candidates = dayEvents.map((e) => ({
                id: e.id,
                from: e.from || null,
                to: e.to || null,
                text: `${e.project?.name || ""} ${e.note || ""}`,
            }));

            const withMatches: UnlinkedMemory[] = unlinked.map((memory) => {
                const subs = getSubEntries(memory);
                const subNotes = subs.map((s) => s.note).filter(Boolean).join(" ");
                const text = `${memory.title} ${memory.note || ""} ${subNotes}`;
                const match = fuzzyMatchBest(
                    { from: memory.from, to: memory.to, text },
                    candidates,
                );
                return { ...memory, suggestedMatch: match || undefined };
            });

            unlinkedByDay.set(date, withMatches);
        }

        if (verbose) {
            const totalUnlinked = Array.from(unlinkedByDay.values()).reduce((s, arr) => s + arr.length, 0);
            logger.info(chalk.dim(`[entries] Unlinked memories: ${totalUnlinked}`));
        }
    }

    // Output
    if (options.format === "json") {
        outputJson(events, options, fetchEntries, unlinkedByDay);
    } else if (options.format === "csv") {
        outputCsv(events);
    } else {
        outputTable(events, fetchEntries, unlinkedByDay);
    }
}

// ─── JSON Output ───

function outputJson(
    events: TimelyEvent[],
    options: EventsOptions,
    fetchEntries: boolean,
    unlinkedByDay: Map<string, UnlinkedMemory[]>,
): void {
    const hasUnlinked = unlinkedByDay.size > 0;

    if (!options.withoutDetails) {
        // Full raw event objects
        if (fetchEntries && hasUnlinked) {
            console.log(JSON.stringify({ events, unlinked: buildUnlinkedSlim(unlinkedByDay) }, null, 2));
        } else {
            console.log(JSON.stringify(events, null, 2));
        }
        return;
    }

    // Slim output
    const slim = events.map((e) => {
        const s = slimEvent(e);
        const entries = (e as TimelyEvent & { entries?: TimelyEntry[] }).entries;
        if (fetchEntries && entries) {
            s.entries = entries.map((ent) => {
                const record: Record<string, unknown> = {
                    title: ent.title,
                    note: ent.note || "",
                    duration: { formatted: ent.duration.formatted },
                };
                const subs = getSubEntries(ent);
                if (subs.length > 0) {
                    record.sub_entries = subs.map((sub) => ({
                        note: sub.note || "",
                        duration: { formatted: sub.duration.formatted },
                    }));
                }
                return record;
            }) as unknown as TimelyEntry[];
        }
        return s;
    });

    if (fetchEntries && hasUnlinked) {
        console.log(JSON.stringify({ events: slim, unlinked: buildUnlinkedSlim(unlinkedByDay) }, null, 2));
    } else {
        console.log(JSON.stringify(slim, null, 2));
    }
}

function buildUnlinkedSlim(unlinkedByDay: Map<string, UnlinkedMemory[]>): UnlinkedMemorySlim[] {
    const result: UnlinkedMemorySlim[] = [];
    for (const [day, memories] of unlinkedByDay) {
        for (const mem of memories) {
            const d = mem.duration;
            const dur = `${String(d.hours).padStart(2, "0")}:${String(d.minutes).padStart(2, "0")}`;
            const slim: UnlinkedMemorySlim = {
                day,
                title: mem.title,
                note: mem.note || "",
                duration: dur,
                from: mem.from ? extractHHMM(mem.from) : null,
                to: mem.to ? extractHHMM(mem.to) : null,
            };
            if (mem.suggestedMatch) {
                slim.suggested_event = {
                    id: mem.suggestedMatch.targetId,
                    score: Math.round(mem.suggestedMatch.score * 100) / 100,
                    reasons: mem.suggestedMatch.reasons,
                };
            }
            const subs = getSubEntries(mem);
            if (subs.length > 0) {
                slim.sub_entries = subs
                    .filter((s) => s.note)
                    .map((s) => ({ note: s.note, duration: s.duration.formatted }));
            }
            result.push(slim);
        }
    }
    return result;
}

// ─── CSV Output ───

function outputCsv(events: TimelyEvent[]): void {
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

// ─── Table Output ───

function outputTable(
    events: TimelyEvent[],
    fetchEntries: boolean,
    unlinkedByDay: Map<string, UnlinkedMemory[]>,
): void {
    logger.info(chalk.cyan(`\nFound ${events.length} event(s):\n`));

    // Build event lookup for fuzzy match display
    const eventById = new Map<number, TimelyEvent>();
    for (const e of events) eventById.set(e.id, e);

    // Group by day
    const byDay = new Map<string, TimelyEvent[]>();
    for (const event of events) {
        if (!byDay.has(event.day)) byDay.set(event.day, []);
        byDay.get(event.day)!.push(event);
    }

    const sortedDays = Array.from(byDay.keys()).sort();
    let totalSeconds = 0;

    for (const day of sortedDays) {
        const dayEvents = byDay.get(day)!;
        const dayTotal = dayEvents.reduce((sum, e) => sum + e.duration.total_seconds, 0);
        totalSeconds += dayTotal;

        console.log(chalk.bold(`${day} (${formatDuration(dayTotal)})`));

        const maxProjectLen = Math.min(
            20,
            Math.max(7, ...dayEvents.map((e) => (e.project?.name || "No Project").length))
        );

        if (fetchEntries) {
            for (const event of dayEvents) {
                const project = (event.project?.name || "No Project").padEnd(maxProjectLen);
                const note = event.note ? ` ${chalk.dim(event.note)}` : "";
                const fromTo = event.from && event.to ? chalk.dim(` ${event.from}-${event.to}`) : "";
                console.log(`  ${chalk.bold(event.duration.formatted.padStart(5))} ${chalk.yellow(project)}${note}${fromTo}`);

                const entries = (event as TimelyEvent & { entries?: TimelyEntry[] }).entries;
                if (entries && entries.length > 0) {
                    for (const ent of entries) {
                        console.log(`  ${" ".repeat(5)} ${chalk.cyan(ent.title.padEnd(maxProjectLen))} ${chalk.dim(ent.duration.formatted)}`);
                        const subs = getSubEntries(ent);
                        if (subs.length > 0) {
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

            // Unlinked memories for this day
            const unlinked = unlinkedByDay.get(day);
            if (unlinked && unlinked.length > 0) {
                const unlinkedTotal = unlinked.reduce((s, m) => s + m.duration.total_seconds, 0);
                console.log(chalk.dim(`  ── unlinked (${formatDuration(unlinkedTotal)}) ──`));
                for (const mem of unlinked) {
                    const dur = mem.duration.formatted.padStart(5);
                    const title = mem.title.substring(0, maxProjectLen).padEnd(maxProjectLen);
                    let matchHint = "";
                    if (mem.suggestedMatch) {
                        const target = eventById.get(mem.suggestedMatch.targetId);
                        const name = target?.project?.name || `#${mem.suggestedMatch.targetId}`;
                        matchHint = chalk.green(` → ${name} (${mem.suggestedMatch.reasons.join(", ")})`);
                    }
                    console.log(`  ${chalk.dim(dur)} ${chalk.magenta(title)}${matchHint}`);

                    const subs = getSubEntries(mem);
                    if (subs.length > 0) {
                        for (const sub of subs) {
                            if (sub.note) {
                                const shortNote = sub.note.length > 60 ? sub.note.substring(0, 58) + ".." : sub.note;
                                console.log(`  ${" ".repeat(5)} ${" ".repeat(maxProjectLen)} ${chalk.dim(`${sub.duration.formatted} ${shortNote}`)}`);
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

    if (fetchEntries) {
        const totalUnlinked = Array.from(unlinkedByDay.values()).reduce((s, arr) => s + arr.length, 0);
        if (totalUnlinked > 0) {
            const totalUnlinkedSeconds = Array.from(unlinkedByDay.values())
                .flat()
                .reduce((s, m) => s + m.duration.total_seconds, 0);
            console.log(`Unlinked: ${totalUnlinked} memories (${formatDuration(totalUnlinkedSeconds)})`);
        }
    }
}
