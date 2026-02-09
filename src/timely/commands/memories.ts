import logger from "@app/logger";
import type { TimelyService } from "@app/timely/api/service";
import type { OAuth2Tokens, TimelyEntry } from "@app/timely/types";
import { fetchMemoriesForDates } from "@app/timely/utils/memories";
import type { Storage } from "@app/utils/storage";
import chalk from "chalk";
import { type Command, Option } from "commander";

export function registerMemoriesCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("memories")
        .description("List auto-tracked activities (suggested entries)")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .option("-a, --account <id>", "Override account ID")
        .option("--from <date>", "Start date (YYYY-MM-DD)")
        .option("--to <date>", "End date (YYYY-MM-DD)")
        .addOption(new Option("--since <date>").hideHelp())
        .addOption(new Option("--upto <date>").hideHelp())
        .option("--day <date>", "Single day (YYYY-MM-DD)")
        .option("--force", "Bypass memory cache, fetch fresh from API")
        .action(async (options) => {
            await memoriesAction(storage, service, options);
        });
}

interface MemoriesOptions {
    format?: string;
    account?: string;
    from?: string;
    to?: string;
    since?: string;
    upto?: string;
    day?: string;
    force?: boolean;
}

async function memoriesAction(storage: Storage, _service: TimelyService, options: MemoriesOptions): Promise<void> {
    const accountId = options.account
        ? parseInt(options.account, 10)
        : await storage.getConfigValue<number>("selectedAccountId");
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    const tokens = await storage.getConfigValue<OAuth2Tokens>("tokens");
    if (!tokens?.access_token) {
        logger.error("Not authenticated. Run 'tools timely login' first.");
        process.exit(1);
    }

    // Resolve --from/--to (primary) with --since/--upto (hidden aliases)
    const from = options.from || options.since;
    const to = options.to || options.upto;

    // Determine dates
    const dates: string[] = [];
    if (options.day) {
        dates.push(options.day);
    } else if (from || to) {
        const since = from || to!;
        const upto = to || from!;
        const start = new Date(since);
        const end = new Date(upto);
        const current = new Date(start);
        while (current <= end) {
            dates.push(current.toISOString().split("T")[0]);
            current.setDate(current.getDate() + 1);
        }
    } else {
        logger.error("Please provide at least one date filter: --from, --to, or --day");
        logger.info("Example: tools timely memories --day 2026-01-30");
        process.exit(1);
    }

    logger.info(chalk.yellow(`Fetching memories for ${dates.length} date(s)...`));

    const result = await fetchMemoriesForDates({
        accountId,
        accessToken: tokens.access_token,
        dates,
        storage,
        force: options.force,
    });
    const allEntries = result.entries;

    if (allEntries.length === 0) {
        logger.info("No memories found.");
        return;
    }

    // JSON output
    if (options.format === "json") {
        console.log(JSON.stringify(allEntries, null, 2));
        return;
    }

    // Group entries by day
    const byDay = new Map<string, TimelyEntry[]>();
    for (const entry of allEntries) {
        const day = entry.date || dates[0];
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(entry);
    }

    const sortedDays = Array.from(byDay.keys()).sort();
    let grandTotal = 0;
    let totalEntries = 0;

    for (const day of sortedDays) {
        const dayEntries = byDay.get(day)!;

        // Group by real app name (from extra_attributes or icon_url, fallback to title)
        const byApp = new Map<string, { totalSeconds: number; entries: TimelyEntry[] }>();
        let dayTotal = 0;
        for (const entry of dayEntries) {
            const app = resolveAppName(entry);
            if (!byApp.has(app)) byApp.set(app, { totalSeconds: 0, entries: [] });
            const group = byApp.get(app)!;
            group.totalSeconds += entry.duration.total_seconds;
            group.entries.push(entry);
            dayTotal += entry.duration.total_seconds;
            totalEntries++;
        }
        grandTotal += dayTotal;

        const sortedApps = Array.from(byApp.entries()).sort((a, b) => b[1].totalSeconds - a[1].totalSeconds);

        // Day header
        console.log(chalk.bold(`${day} (${fmtDurHm(dayTotal)})`));

        for (const [app, data] of sortedApps) {
            console.log(`  ${padDur(fmtDurHm(data.totalSeconds))} ${chalk.yellow(app)}`);

            // Show sub-entries for each memory in this app group
            for (const entry of data.entries) {
                // API uses "entries" on suggested_entries, TS type uses "sub_entries"
                const subs =
                    entry.sub_entries ||
                    ((entry as unknown as Record<string, unknown>).entries as typeof entry.sub_entries) ||
                    [];
                if (subs.length > 0) {
                    for (const sub of subs) {
                        if (sub.note) {
                            console.log(
                                `    ${chalk.dim(padDur(fmtDurHm(sub.duration.total_seconds)))} ${chalk.blue(sub.note)}`
                            );
                        }
                    }
                } else if (entry.note) {
                    console.log(
                        `    ${chalk.dim(padDur(fmtDurHm(entry.duration.total_seconds)))} ${chalk.blue(entry.note)}`
                    );
                }
            }
        }
        console.log();
    }

    // Summary
    console.log(chalk.cyan("─".repeat(60)));
    console.log(chalk.bold(`Total: ${fmtDurHm(grandTotal)}`));
    console.log(`Memories: ${totalEntries}, Days: ${sortedDays.length}`);
}

/**
 * Resolve the real application name from a memory entry.
 * Checks extra_attributes (sub-entries), icon_url, then falls back to title.
 */
function resolveAppName(entry: TimelyEntry): string {
    // API returns "entries" (full TimelyEntry objects with extra_attributes), TS type has "sub_entries"
    const apiEntries = (entry as unknown as Record<string, unknown>).entries as TimelyEntry[] | undefined;
    if (apiEntries && apiEntries.length > 0) {
        const appAttr = apiEntries[0].extra_attributes?.find((a) => a.name === "application");
        if (appAttr?.value) return appAttr.value;
    }

    // Try extracting app name from icon_url (e.g., "timeline_app_logos/brave-...")
    if (entry.icon_url) {
        const match = entry.icon_url.match(/timeline_app_logos\/([a-z_-]+?)(?:-[a-f0-9]|\.)/i);
        if (match) {
            const name = match[1].replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            return name;
        }
    }

    return entry.title || "Unknown";
}

function fmtDurHm(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

/** Right-pad duration string to fixed width for column alignment */
function padDur(dur: string): string {
    return dur.padEnd(7);
}
