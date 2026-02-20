/**
 * Azure DevOps CLI Tool - History Command
 *
 * Provides work item history commands: show, search, and sync.
 * The `show` handler is implemented inline; search and sync are imported.
 */

import { Api } from "@app/azure-devops/api";
import { formatJSON, isHistoryFresh, loadWorkItemCache, updateWorkItemCacheSection } from "@app/azure-devops/cache";
import { buildWorkItemHistory, calculateTimeInState, userMatches } from "@app/azure-devops/history";
import type { AssignmentPeriod, StatePeriod, WorkItemHistorySection } from "@app/azure-devops/types";
import { requireConfig } from "@app/azure-devops/utils";
import logger from "@app/logger";
import { formatDuration as _formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

import { type ActivityOptions, handleHistoryActivity } from "./history-activity";
import { handleHistorySearch, type SearchOptions } from "./history-search";
import { handleHistorySync } from "./history-sync";

// ============= Types =============

interface ShowOptions {
    format?: "summary" | "timeline" | "json";
    force?: boolean;
    assignedTo?: string;
    state?: string;
    from?: string;
    to?: string;
}

interface FilteredHistory {
    assignmentPeriods: AssignmentPeriod[];
    statePeriods: StatePeriod[];
}

// ============= Helpers =============

/**
 * Format a duration in minutes to a human-readable string like "2h 30m".
 */
export function formatDuration(minutes: number): string {
    return _formatDuration(minutes, "min", "hm-smart");
}

/**
 * Format an ISO date string to a short display format (YYYY-MM-DD HH:MM).
 */
function formatDate(isoDate: string): string {
    const d = new Date(isoDate);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Pad a string to a fixed width (right-padded with spaces).
 */
function pad(str: string, width: number): string {
    return str.length >= width ? str : str + " ".repeat(width - str.length);
}

// ============= Filtering =============

/**
 * Filter assignment and state periods by assignee, state, and date range.
 */
function filterHistory(history: WorkItemHistorySection, options: ShowOptions): FilteredHistory {
    let { assignmentPeriods, statePeriods } = history;

    // Filter by assigned-to
    if (options.assignedTo) {
        const query = options.assignedTo;
        assignmentPeriods = assignmentPeriods.filter((period) => userMatches(period.assignee, query));
        statePeriods = statePeriods.filter(
            (period) => period.assigneeDuring && userMatches(period.assigneeDuring, query)
        );
    }

    // Filter by state names (comma-separated)
    if (options.state) {
        const states = options.state.split(",").map((s) => s.trim().toLowerCase());
        statePeriods = statePeriods.filter((period) => states.includes(period.state.toLowerCase()));
    }

    // Filter by date range (--from)
    if (options.from) {
        const fromDate = new Date(options.from).getTime();
        assignmentPeriods = assignmentPeriods.filter(
            (period) => !period.endDate || new Date(period.endDate).getTime() >= fromDate
        );
        statePeriods = statePeriods.filter(
            (period) => !period.endDate || new Date(period.endDate).getTime() >= fromDate
        );
    }

    // Filter by date range (--to)
    if (options.to) {
        const toDate = new Date(options.to).getTime();
        assignmentPeriods = assignmentPeriods.filter((period) => new Date(period.startDate).getTime() <= toDate);
        statePeriods = statePeriods.filter((period) => new Date(period.startDate).getTime() <= toDate);
    }

    return { assignmentPeriods, statePeriods };
}

// ============= Output Formatters =============

/**
 * Print a summary view: assignment periods table, state periods table, and time-in-state.
 */
function printSummary(workItemId: number, filtered: FilteredHistory, history: WorkItemHistorySection): void {
    p.intro(pc.bgCyan(pc.black(` Work Item #${workItemId} History `)));

    // Assignment periods table
    if (filtered.assignmentPeriods.length > 0) {
        p.log.step(pc.bold("Assignment Periods"));
        const header = `${pad("Assignee", 30)} ${pad("Start", 18)} ${pad("End", 18)} Duration`;
        console.log(pc.dim(header));
        console.log(pc.dim("-".repeat(header.length)));

        for (const period of filtered.assignmentPeriods) {
            const endStr = period.endDate ? formatDate(period.endDate) : pc.yellow("(current)");
            const durStr =
                period.durationMinutes != null ? formatDuration(period.durationMinutes) : pc.yellow("ongoing");
            console.log(
                `${pad(period.assignee, 30)} ${pad(formatDate(period.startDate), 18)} ${pad(endStr, 18)} ${durStr}`
            );
        }
        console.log();
    } else {
        p.log.warn("No assignment periods found.");
    }

    // State periods table
    if (filtered.statePeriods.length > 0) {
        p.log.step(pc.bold("State Periods"));
        const header = `${pad("State", 20)} ${pad("Start", 18)} ${pad("End", 18)} ${pad("Duration", 10)} Assignee`;
        console.log(pc.dim(header));
        console.log(pc.dim("-".repeat(header.length)));

        for (const period of filtered.statePeriods) {
            const endStr = period.endDate ? formatDate(period.endDate) : pc.yellow("(current)");
            const durStr =
                period.durationMinutes != null ? formatDuration(period.durationMinutes) : pc.yellow("ongoing");
            const assignee = period.assigneeDuring ?? pc.dim("(none)");
            console.log(
                `${pad(period.state, 20)} ${pad(formatDate(period.startDate), 18)} ${pad(endStr, 18)} ${pad(durStr, 10)} ${assignee}`
            );
        }
        console.log();
    } else {
        p.log.warn("No state periods found.");
    }

    // Time in state summary
    const timeInState = calculateTimeInState(history);
    if (timeInState.size > 0) {
        p.log.step(pc.bold("Time in State Summary"));
        const header = `${pad("State", 20)} ${pad("Total", 12)} Breakdown by Assignee`;
        console.log(pc.dim(header));
        console.log(pc.dim("-".repeat(header.length)));

        for (const [state, entry] of timeInState) {
            const byAssigneeStr = Array.from(entry.byAssignee.entries())
                .map(([assignee, mins]) => `${assignee}: ${formatDuration(mins)}`)
                .join(", ");
            console.log(
                `${pad(state, 20)} ${pad(formatDuration(entry.totalMinutes), 12)} ${byAssigneeStr || pc.dim("(no assignee)")}`
            );
        }
        console.log();
    }

    p.outro(pc.green("Done"));
}

/**
 * Print a timeline view: chronological events sorted by date.
 */
function printTimeline(workItemId: number, filtered: FilteredHistory): void {
    p.intro(pc.bgCyan(pc.black(` Work Item #${workItemId} Timeline `)));

    interface TimelineEvent {
        date: string;
        type: "assignment" | "state";
        description: string;
    }

    const events: TimelineEvent[] = [];

    // Add assignment start events
    for (const period of filtered.assignmentPeriods) {
        events.push({
            date: period.startDate,
            type: "assignment",
            description: `Assigned to ${pc.bold(period.assignee)}`,
        });
        if (period.endDate) {
            events.push({
                date: period.endDate,
                type: "assignment",
                description: `Unassigned from ${pc.bold(period.assignee)} (${period.durationMinutes != null ? formatDuration(period.durationMinutes) : "?"})`,
            });
        }
    }

    // Add state change events
    for (const period of filtered.statePeriods) {
        const assigneeInfo = period.assigneeDuring ? ` (assignee: ${period.assigneeDuring})` : "";
        events.push({
            date: period.startDate,
            type: "state",
            description: `State changed to ${pc.bold(period.state)}${assigneeInfo}`,
        });
        if (period.endDate) {
            events.push({
                date: period.endDate,
                type: "state",
                description: `Left state ${pc.bold(period.state)} after ${period.durationMinutes != null ? formatDuration(period.durationMinutes) : "?"}`,
            });
        }
    }

    // Sort chronologically
    events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (events.length === 0) {
        p.log.warn("No events found matching the filters.");
    } else {
        for (const event of events) {
            const icon = event.type === "assignment" ? pc.blue("[A]") : pc.magenta("[S]");
            console.log(`${pc.dim(formatDate(event.date))}  ${icon} ${event.description}`);
        }
    }

    console.log();
    p.outro(pc.green("Done"));
}

/**
 * Print JSON output of the filtered history data.
 */
function printJson(workItemId: number, filtered: FilteredHistory, history: WorkItemHistorySection): void {
    const output = {
        workItemId,
        assignmentPeriods: filtered.assignmentPeriods,
        statePeriods: filtered.statePeriods,
        timeInState: Object.fromEntries(
            Array.from(calculateTimeInState(history).entries()).map(([state, entry]) => [
                state,
                {
                    totalMinutes: entry.totalMinutes,
                    byAssignee: Object.fromEntries(entry.byAssignee),
                },
            ])
        ),
    };
    console.log(formatJSON(output));
}

// ============= Show Handler =============

async function handleHistoryShow(idStr: string, options: ShowOptions): Promise<void> {
    const id = parseInt(idStr, 10);
    if (Number.isNaN(id) || id <= 0) {
        p.log.error(`Invalid work item ID: ${pc.bold(idStr)}`);
        process.exit(1);
    }

    const config = requireConfig();
    const format = options.format ?? "summary";

    // Check cache unless --force
    let history: WorkItemHistorySection | null = null;
    if (!options.force) {
        const cached = await loadWorkItemCache(id);
        if (cached && isHistoryFresh(cached) && cached.history) {
            history = cached.history;
            logger.debug(`[history] Loaded from workitem cache for #${id}`);
        }
    }

    // Fetch from API if not cached
    if (!history) {
        const api = new Api(config);
        const spinner = p.spinner();
        spinner.start(`Fetching updates for work item #${id}...`);

        try {
            const updates = await api.getWorkItemUpdates(id);
            const built = buildWorkItemHistory(updates);
            history = {
                updates: built.updates,
                assignmentPeriods: built.assignmentPeriods,
                statePeriods: built.statePeriods,
            };
            await updateWorkItemCacheSection(id, { history });
            spinner.stop(`Fetched ${updates.length} updates for work item #${id}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            spinner.stop(pc.red(`Failed to fetch updates: ${message}`));
            process.exit(1);
        }
    }

    // Apply filters
    const filtered = filterHistory(history, options);

    // Output in requested format
    switch (format) {
        case "summary":
            printSummary(id, filtered, history);
            break;
        case "timeline":
            printTimeline(id, filtered);
            break;
        case "json":
            printJson(id, filtered, history);
            break;
    }
}

// ============= Registration =============

export function registerHistoryCommand(program: Command): void {
    const history = program.command("history").description("Work item history commands");

    history
        .command("show <id>")
        .alias("get")
        .description("Show history for a work item")
        .option("-f, --format <format>", "Output format (summary, timeline, json)", "summary")
        .option("--force", "Force refresh, ignore cache")
        .option("--assigned-to <name>", "Filter by assignee name (fuzzy match)")
        .option("--state <states>", "Filter by state (comma-separated)")
        .option("--from <date>", "Filter from date (ISO format)")
        .option("--since <date>", "Alias for --from")
        .option("--to <date>", "Filter to date (ISO format)")
        .option("--until <date>", "Alias for --to")
        .action(async (idStr: string, options: ShowOptions & { since?: string; until?: string }) => {
            if (options.since && !options.from) options.from = options.since;
            if (options.until && !options.to) options.to = options.until;
            await handleHistoryShow(idStr, options);
        });

    history
        .command("search")
        .description("Search history across work items (WIQL or local)")
        .option("--assigned-to <name>", "Items ever assigned to user (fuzzy match)")
        .option("--assigned-to-me", "Shortcut for --assigned-to @me")
        .option("--state <states>", "Items ever in state(s) (comma-separated)")
        .option("--from <date>", "From date (ISO format)")
        .option("--since <date>", "Alias for --from")
        .option("--to <date>", "To date (ISO format)")
        .option("--until <date>", "Alias for --to")
        .option("--min-time <duration>", "Min time in state/assigned (e.g. 2h, 30m)")
        .option("--wiql", "Use WIQL EVER query (server-side, no local history needed)")
        .option("--current", "Search current assignment (= instead of EVER)")
        .option("-o, --output <format>", "Output format (table, json)", "table")
        .action((options: SearchOptions & { since?: string; until?: string }) => {
            if (options.since && !options.from) options.from = options.since;
            if (options.until && !options.to) options.to = options.until;
            return handleHistorySearch(options);
        });

    history
        .command("sync")
        .description("Bulk sync history for cached work items")
        .option("-f, --force", "Force refresh all")
        .option("--dry-run", "Show what would be synced")
        .option("--since <date>", "Only revisions since date")
        .option("--batch", "Use batch reporting API instead of per-item /updates")
        .action(handleHistorySync);

    history
        .command("activity")
        .description("Show user activity timeline across work items")
        .option("--user <name>", "User to show activity for (default: @me)")
        .option("--from <date>", "From date (ISO format, e.g. 2026-02-07)")
        .option("--since <date>", "Alias for --from")
        .option("--to <date>", "To date (ISO format)")
        .option("--until <date>", "Alias for --to")
        .option("-o, --format <format>", "Output format (timeline, summary, json)", "timeline")
        .option("--no-comments", "Skip fetching comments (faster)")
        .option("--discover", "Query Azure DevOps for all items you changed (not just locally cached)")
        .action(async (opts: ActivityOptions & { since?: string; until?: string; comments?: boolean }) => {
            if (opts.since && !opts.from) opts.from = opts.since;
            if (opts.until && !opts.to) opts.to = opts.until;
            opts.includeComments = opts.comments !== false;
            await handleHistoryActivity(opts);
        });
}
