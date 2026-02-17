/**
 * Azure DevOps CLI - History Search Command
 *
 * Two search modes:
 *   1. WIQL (--wiql): Server-side query via EVER operator + batch fetch details
 *   2. Local (default): Scan cached history files, filter by assignee/state/date/time
 */

import { readdirSync } from "node:fs";
import { Api } from "@app/azure-devops/api";
import { formatJSON, loadHistoryCache, storage } from "@app/azure-devops/cache";
import { resolveUser, userMatches } from "@app/azure-devops/history";
import type { AzureConfig, WorkItem, WorkItemHistory } from "@app/azure-devops/types";
import { requireConfig } from "@app/azure-devops/utils";
import { buildCombinedQuery, buildEverAssignedQuery } from "@app/azure-devops/wiql-builder";
import logger from "@app/logger";
import { suggestCommand } from "@app/utils/cli";
import { formatDuration as _formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import pc from "picocolors";

// ============= Types =============

export interface SearchOptions {
    assignedTo?: string;
    assignedToMe?: boolean;
    state?: string;
    from?: string;
    to?: string;
    minTime?: string;
    wiql?: boolean;
    current?: boolean;
    output: "json" | "table";
}

/** A local search result row (one per cached work item that matched) */
interface LocalSearchResult {
    workItemId: number;
    title: string;
    currentState: string;
    assignee: string;
    totalMinutes: number;
    matchedStates: string[];
}

// ============= Helpers =============

/** Parse a human-friendly duration like "2h", "30m", "1h30m" to minutes */
function parseMinTime(raw: string): number {
    const hourMatch = raw.match(/(\d+)\s*h/i);
    const minMatch = raw.match(/(\d+)\s*m/i);
    let total = 0;
    if (hourMatch) total += parseInt(hourMatch[1], 10) * 60;
    if (minMatch) total += parseInt(minMatch[1], 10);
    // Plain number without unit defaults to minutes
    if (!hourMatch && !minMatch) {
        const num = parseInt(raw, 10);
        if (!isNaN(num)) total = num;
    }
    return total;
}

/** Format minutes as "Xh Ym" */
function formatDuration(minutes: number): string {
    return _formatDuration(minutes, "min", "hm-smart");
}

/** Pad a string to a fixed width (right-pad with spaces) */
function pad(str: string, width: number): string {
    return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

// ============= Mode 1: WIQL Search =============

async function wiqlSearch(options: SearchOptions, api: Api, config: AzureConfig): Promise<void> {
    let assignedToValue: string | undefined;
    const isMeMacro = options.assignedTo?.toLowerCase() === "@me";

    // Resolve fuzzy user name (skip for @Me — it's a WIQL macro)
    if (options.assignedTo) {
        if (isMeMacro) {
            assignedToValue = "@Me";
            p.log.info(`Using WIQL macro: ${pc.bold("@Me")}`);
        } else {
            const members = await api.getTeamMembers();
            const resolved = resolveUser(options.assignedTo, members);
            if (!resolved) {
                p.log.error(`No team member matches "${options.assignedTo}"`);
                process.exit(1);
            }
            assignedToValue = resolved.displayName;
            p.log.info(`Resolved user: ${pc.bold(assignedToValue)}`);
        }
    }

    // Build WIQL
    const useCurrent = options.current ?? false;
    const wiql =
        assignedToValue && !options.state
            ? useCurrent
                ? buildCombinedQuery({
                      currentAssignedTo: assignedToValue,
                      from: options.from,
                      to: options.to,
                      isMacro: isMeMacro,
                  })
                : buildEverAssignedQuery(assignedToValue, options.from, options.to, isMeMacro)
            : buildCombinedQuery({
                  assignedTo: useCurrent ? undefined : assignedToValue,
                  currentAssignedTo: useCurrent ? assignedToValue : undefined,
                  states: options.state,
                  from: options.from,
                  to: options.to,
                  isMacro: isMeMacro,
              });

    logger.debug(`[history-search] WIQL:\n${wiql}`);

    // Execute
    const spinner = p.spinner();
    spinner.start("Running WIQL query...");
    const response = await api.runWiql(wiql, { top: 1000 });
    spinner.stop(`Query returned ${response.workItems.length} work items`);

    if (response.workItems.length === 0) {
        p.log.warn("No work items found.");
        return;
    }

    // Batch-fetch work item details (max 200 per request)
    const ids = response.workItems.map((wi) => wi.id);
    const fields = [
        "System.Id",
        "System.Title",
        "System.State",
        "System.AssignedTo",
        "System.ChangedDate",
        "System.WorkItemType",
    ].join(",");

    const allItems: WorkItem[] = [];
    const batchSize = 200;

    for (let i = 0; i < ids.length; i += batchSize) {
        const batchIds = ids.slice(i, i + batchSize);
        const idsParam = batchIds.join(",");
        const result = await fetchWorkItemsBatch(config, idsParam, fields);
        allItems.push(...result);
    }

    // Output
    if (options.output === "json") {
        console.log(formatJSON(allItems));
    } else {
        printWorkItemsTable(allItems);
    }
}

/** Fetch work items by IDs using az rest (since Api.get is private) */
async function fetchWorkItemsBatch(config: AzureConfig, idsParam: string, fields: string): Promise<WorkItem[]> {
    const { $ } = await import("bun");
    const url = Api.orgUrl(config, ["wit", "workitems"], { ids: idsParam, fields });

    // Get a token via az CLI
    const tokenResult =
        await $`az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`.quiet();
    const token = tokenResult.text().trim();

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch work items: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
        value: Array<{ id: number; rev: number; fields: Record<string, unknown> }>;
    };

    return data.value.map((item) => {
        const f = item.fields;
        return {
            id: item.id,
            rev: item.rev,
            title: (f["System.Title"] as string) ?? "",
            state: (f["System.State"] as string) ?? "",
            changed: (f["System.ChangedDate"] as string) ?? "",
            assignee: (f["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName,
            url: Api.workItemWebUrl(config, item.id),
        };
    });
}

/** Print work items as a simple table */
function printWorkItemsTable(items: WorkItem[]): void {
    if (items.length === 0) return;

    const header = `${pad("ID", 8)} ${pad("State", 14)} ${pad("Assignee", 24)} ${pad("Title", 50)}`;
    console.log(pc.bold(header));
    console.log("-".repeat(header.length));

    for (const item of items) {
        const line = `${pad(String(item.id), 8)} ${pad(item.state, 14)} ${pad(item.assignee ?? "-", 24)} ${pad(
            item.title,
            50
        )}`;
        console.log(line);
    }

    console.log(`\n${pc.dim(`${items.length} work items`)}`);
}

// ============= Mode 2: Local Search =============

async function localSearch(options: SearchOptions): Promise<void> {
    const cacheDir = storage.getCacheDir();
    const minTimeMinutes = options.minTime ? parseMinTime(options.minTime) : 0;

    // Scan cache directory for history-<id>.json files
    let historyFiles: string[];
    try {
        historyFiles = readdirSync(cacheDir).filter((f) => f.startsWith("history-") && f.endsWith(".json"));
    } catch {
        p.log.warn("No history cache found. Run history download first.");
        return;
    }

    if (historyFiles.length === 0) {
        p.log.warn("No cached history files found. Download history first.");
        return;
    }

    const spinner = p.spinner();
    spinner.start(`Scanning ${historyFiles.length} history files...`);

    const results: LocalSearchResult[] = [];
    let oldestActivity = Infinity;
    let newestActivity = 0;
    let lastSyncTime = 0;
    let scannedCount = 0;

    for (const file of historyFiles) {
        const idMatch = file.match(/^history-(\d+)\.json$/);
        if (!idMatch) continue;

        const id = parseInt(idMatch[1], 10);
        const history = await loadHistoryCache(id);
        if (!history) continue;

        scannedCount++;
        const fetchTime = new Date(history.fetchedAt).getTime();
        if (fetchTime > lastSyncTime) lastSyncTime = fetchTime;

        // Track data date range from earliest state/assignment period
        for (const period of history.statePeriods) {
            const start = new Date(period.startDate).getTime();
            if (start < oldestActivity) oldestActivity = start;
            const end = period.endDate ? new Date(period.endDate).getTime() : Date.now();
            if (end > newestActivity) newestActivity = end;
        }

        // Filter by assignee
        if (options.assignedTo) {
            const hasMatch = history.assignmentPeriods.some((period) =>
                userMatches(period.assignee, options.assignedTo!)
            );
            if (!hasMatch) continue;
        }

        // Filter state periods by criteria
        let matchedPeriods = history.statePeriods;

        if (options.state) {
            const states = options.state.split(",").map((s) => s.trim().toLowerCase());
            matchedPeriods = matchedPeriods.filter((p) => states.includes(p.state.toLowerCase()));
        }

        if (options.assignedTo) {
            matchedPeriods = matchedPeriods.filter(
                (period) => period.assigneeDuring != null && userMatches(period.assigneeDuring, options.assignedTo!)
            );
        }

        // Filter by date range
        if (options.from) {
            const fromDate = new Date(options.from).getTime();
            matchedPeriods = matchedPeriods.filter((period) => {
                const endTime = period.endDate ? new Date(period.endDate).getTime() : Date.now();
                return endTime >= fromDate;
            });
        }

        if (options.to) {
            const toDate = new Date(options.to).getTime();
            matchedPeriods = matchedPeriods.filter((period) => new Date(period.startDate).getTime() <= toDate);
        }

        if (matchedPeriods.length === 0) continue;

        // Sum up time
        const totalMinutes = matchedPeriods.reduce((sum, period) => sum + (period.durationMinutes ?? 0), 0);

        // Filter by minimum time
        if (totalMinutes < minTimeMinutes) continue;

        // Derive title/state from last update or fallback
        const currentState = deriveCurrentState(history);
        const currentAssignee = deriveCurrentAssignee(history);
        const matchedStates = [...new Set(matchedPeriods.map((mp) => mp.state))];

        results.push({
            workItemId: history.workItemId,
            title: deriveTitle(history),
            currentState,
            assignee: currentAssignee,
            totalMinutes,
            matchedStates,
        });
    }

    spinner.stop(`Found ${results.length} matching work items (from cache)`);

    // Sort by total time descending
    results.sort((a, b) => b.totalMinutes - a.totalMinutes);

    // Output
    // Build cache stats
    const dataFrom = oldestActivity < Infinity ? new Date(oldestActivity).toISOString().slice(0, 10) : "?";
    const dataTo = newestActivity > 0 ? new Date(newestActivity).toISOString().slice(0, 10) : "?";
    const syncDate = lastSyncTime > 0 ? new Date(lastSyncTime).toISOString().slice(0, 16).replace("T", " ") : "?";

    if (options.output === "json") {
        console.log(
            formatJSON({
                results,
                stats: { cached: scannedCount, matched: results.length, dataFrom, dataTo, syncDate },
            })
        );
    } else {
        printLocalResultsTable(results);

        // Stats
        console.log(pc.dim(`\nCache: ${scannedCount} items, data ${dataFrom} → ${dataTo}, synced ${syncDate}`));

        // Suggest WIQL equivalent
        const wiqlCmd = suggestCommand("tools azure-devops", { add: ["--wiql"] });
        p.log.message(pc.dim(`Tip: For server-side search, run:\n  ${wiqlCmd}`));
    }
}

/** Derive the current state from the last state period */
function deriveCurrentState(history: WorkItemHistory): string {
    if (history.statePeriods.length === 0) return "Unknown";
    return history.statePeriods[history.statePeriods.length - 1].state;
}

/** Derive the current assignee from the last assignment period */
function deriveCurrentAssignee(history: WorkItemHistory): string {
    if (history.assignmentPeriods.length === 0) return "-";
    return history.assignmentPeriods[history.assignmentPeriods.length - 1].assignee;
}

/** Derive title from the first update that set System.Title */
function deriveTitle(history: WorkItemHistory): string {
    for (const update of history.updates) {
        const titleChange = update.fields?.["System.Title"];
        if (titleChange?.newValue) {
            return titleChange.newValue as string;
        }
    }
    return `Work Item #${history.workItemId}`;
}

/** Print local search results as a table */
function printLocalResultsTable(results: LocalSearchResult[]): void {
    if (results.length === 0) {
        p.log.info("No matching work items found.");
        return;
    }

    const header = `${pad("ID", 8)} ${pad("Time", 10)} ${pad("State", 14)} ${pad("Assignee", 24)} ${pad("Title", 44)}`;
    console.log(pc.bold(header));
    console.log("-".repeat(header.length));

    for (const r of results) {
        const line = `${pad(String(r.workItemId), 8)} ${pad(formatDuration(r.totalMinutes), 10)} ${pad(
            r.currentState,
            14
        )} ${pad(r.assignee, 24)} ${pad(r.title, 44)}`;
        console.log(line);
    }

    const totalTime = results.reduce((sum, r) => sum + r.totalMinutes, 0);
    console.log(`\n${pc.dim(`${results.length} work items, total time: ${formatDuration(totalTime)}`)}`);
}

// ============= Main Handler =============

export async function handleHistorySearch(options: SearchOptions): Promise<void> {
    // Expand --assigned-to-me alias
    if (options.assignedToMe && !options.assignedTo) {
        options.assignedTo = "@me";
    }

    // @me is a server-side WIQL macro — auto-enable WIQL mode
    if (options.assignedTo?.toLowerCase() === "@me" && !options.wiql) {
        options.wiql = true;
    }

    if (options.wiql) {
        const config = requireConfig();
        const api = new Api(config);
        await wiqlSearch(options, api, config);
    } else {
        await localSearch(options);
    }
}
