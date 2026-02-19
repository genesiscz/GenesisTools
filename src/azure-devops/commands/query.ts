/**
 * Azure DevOps CLI Tool - Query Command
 *
 * Runs Azure DevOps queries and displays results with change detection.
 */

import { Api } from "@app/azure-devops/api";
import {
    CACHE_TTL,
    formatJSON,
    loadGlobalCache,
    saveGlobalCache,
    storage,
} from "@app/azure-devops/cache";
import type {
    AzureConfig,
    ChangeInfo,
    OutputFormat,
    QueriesCache,
    QueryCache,
    QueryFilters,
    QueryItemMetadata,
    WorkItem,
} from "@app/azure-devops/types";
import {
    detectChanges,
    extractQueryId,
    findQueryByName,
    getRelativeTime,
    isQueryIdOrUrl,
    requireConfig,
} from "@app/azure-devops/utils";
import logger, { consoleLog } from "@app/logger";
import type { Command } from "commander";

// Silent mode for JSON output - suppresses progress messages
let silentMode = false;
const log = (msg: string): void => {
    if (!silentMode) consoleLog.info(msg);
};

// ============= Output Formatters =============

function formatAI(queryId: string, items: WorkItem[], changes: ChangeInfo[], cacheTime?: Date): string {
    const lines: string[] = [];

    lines.push(`# Query Results: ${queryId}`);
    lines.push("");

    if (cacheTime) {
        lines.push(`Last checked: ${getRelativeTime(cacheTime)}`);
        lines.push("");
    }

    lines.push(`Total: ${items.length} work items`);
    lines.push("");

    // Work items table
    lines.push("| ID | Title | State | Severity | Changed | Assignee |");
    lines.push("|-----|-------|-------|----------|---------|----------|");
    for (const item of items) {
        const title = item.title.length > 40 ? `${item.title.slice(0, 37)}...` : item.title;
        const changed = item.changed ? new Date(item.changed).toISOString().slice(0, 16).replace("T", " ") : "-";
        lines.push(
            `| ${item.id} | ${title} | ${item.state} | ${item.severity || "-"} | ${changed} | ${item.assignee || "-"} |`
        );
    }

    if (changes.length === 0) {
        lines.push("");
        lines.push("No changes detected since last check.");
    } else {
        lines.push("");
        lines.push(`## Changes Detected (${changes.length})`);

        for (const change of changes) {
            lines.push("");
            if (change.type === "new") {
                lines.push(`### NEW: #${change.id} - ${change.newData.title}`);
                lines.push(`- State: ${change.newData.state}`);
                lines.push(`- Severity: ${change.newData.severity || "N/A"}`);
                lines.push(`- Assignee: ${change.newData.assignee || "unassigned"}`);
            } else {
                lines.push(`### UPDATED: #${change.id} - ${change.newData.title}`);
                for (const c of change.changes) {
                    lines.push(`- ${c}`);
                }
            }
        }

        lines.push("");
        lines.push("## Action Required");
        lines.push("");
        lines.push("To get full details + comments for changed items, run:");
        for (const change of changes) {
            lines.push(`  tools azure-devops --workitem ${change.id}`);
        }
    }

    return lines.join("\n");
}

function formatMD(items: WorkItem[]): string {
    const lines: string[] = [];
    lines.push("| ID | Title | State | Severity | Changed | Assignee |");
    lines.push("|---|---|---|---|---|---|");
    for (const item of items) {
        const changed = item.changed ? new Date(item.changed).toISOString().slice(0, 16).replace("T", " ") : "-";
        lines.push(
            `| ${item.id} | ${item.title.slice(0, 50)} | ${item.state} | ${item.severity || "-"} | ${changed} | ${item.assignee || "-"} |`
        );
    }
    return lines.join("\n");
}

// ============= Query ID Resolution =============

/**
 * Resolve query input to a query ID
 * Supports: URL, GUID, or query name (with fuzzy matching)
 */
async function resolveQueryId(input: string, api: Api, config: AzureConfig): Promise<string> {
    // If it looks like a GUID or URL, use extractQueryId
    if (isQueryIdOrUrl(input)) {
        return extractQueryId(input);
    }

    // Otherwise, treat as a query name - need to search
    log(`Searching for query: "${input}"`);

    // Load queries cache
    await storage.ensureDirs();
    let queriesCache = await storage.getCacheFile<QueriesCache>("queries-list.json", CACHE_TTL.queries);

    // Refresh cache if needed
    if (!queriesCache || queriesCache.project !== config.project) {
        log("Fetching queries list from Azure DevOps...");
        const queries = await api.getAllQueries();
        queriesCache = {
            project: config.project,
            queries,
            fetchedAt: new Date().toISOString(),
        };
        await storage.putCacheFile("queries-list.json", queriesCache, CACHE_TTL.queries);
        log(`Cached ${queries.length} queries`);
    }

    // Get IDs of recently-used queries from cache files for boosted fuzzy matching
    const cacheFiles = await storage.listCacheFiles(false);
    const recentQueryIds = new Set<string>(
        cacheFiles
            .filter((f) => f.startsWith("query-") && f.endsWith(".json"))
            .map((f) => f.replace(/^query-/, "").replace(/\.json$/, ""))
    );

    // Find the best match
    const result = findQueryByName(input, queriesCache.queries, recentQueryIds);

    if (!result) {
        throw new Error(`No query found matching "${input}". Use --query with a GUID or URL instead.`);
    }

    // If exact match (score = 1.0), use it directly
    if (result.score >= 0.95) {
        log(`Found query: "${result.query.name}" (${result.query.path})`);
        return result.query.id;
    }

    // If good match but not exact, show what we found
    log(`Best match: "${result.query.name}" (${result.query.path}) [${Math.round(result.score * 100)}% match]`);

    if (result.alternatives.length > 0) {
        log(`   Other matches:`);
        for (const alt of result.alternatives) {
            log(`   - "${alt.name}" (${alt.path})`);
        }
    }

    return result.query.id;
}

// ============= Work Item Download Handler (to be set externally) =============

/**
 * Function to handle work item downloads.
 * This is set by the workitem command module to allow downloading work items.
 */
export type WorkItemHandler = (
    input: string,
    format: OutputFormat,
    forceRefresh: boolean,
    category?: string,
    taskFolders?: boolean,
    queryMetadata?: Map<number, QueryItemMetadata>,
    fetchOptions?: { comments?: boolean; updates?: boolean }
) => Promise<void>;

let workItemHandler: WorkItemHandler | null = null;

/**
 * Set the work item handler function.
 * Called by workitem.ts to enable work item downloads from queries.
 */
export function setWorkItemHandler(handler: WorkItemHandler): void {
    workItemHandler = handler;
}

// ============= Main Query Handler =============

interface QueryOptions {
    format: OutputFormat;
    force: boolean;
    state?: string;
    severity?: string;
    changesFrom?: string;
    changesTo?: string;
    downloadWorkitems?: boolean;
    category?: string;
    taskFolders?: boolean;
}

/**
 * Handle query command - run query and display results
 */
export async function handleQuery(
    input: string,
    format: OutputFormat,
    forceRefresh: boolean,
    filters?: QueryFilters,
    downloadWorkitems?: boolean,
    category?: string,
    taskFolders?: boolean
): Promise<void> {
    silentMode = format === "json"; // Suppress progress messages for JSON output
    logger.debug(`[query] Starting with input: ${input}, force=${forceRefresh}`);
    if (filters)
        logger.debug(
            `[query] Filters: states=${filters.states?.join(",")}, severities=${filters.severities?.join(",")}`
        );

    const config = requireConfig();
    logger.debug(`[query] Config loaded: org=${config.org}, project=${config.project}`);
    const api = new Api(config);
    logger.debug(`[query] Resolving query ID from input...`);
    const queryId = await resolveQueryId(input, api, config);
    logger.debug(`[query] Resolved query ID: ${queryId}`);

    // Load old cache
    logger.debug(`[query] Loading cache (force=${forceRefresh})...`);
    const rawCache = forceRefresh ? null : await loadGlobalCache<QueryCache>("query", queryId);
    const oldCache = rawCache?.items || null;
    const oldCacheTime = rawCache?.fetchedAt ? new Date(rawCache.fetchedAt) : undefined;
    logger.debug(
        `[query] Cache: ${rawCache ? `found with ${oldCache?.length || 0} items` : "not found or forced refresh"}`
    );

    // Run query
    logger.debug(`[query] Running query via API...`);
    let items = await api.runQuery(queryId);
    logger.debug(`[query] Query returned ${items.length} items`);

    // Apply filters
    if (filters?.states && filters.states.length > 0) {
        const normalizedStates = filters.states.map((s) => s.toLowerCase());
        const beforeCount = items.length;
        items = items.filter((item) => normalizedStates.includes(item.state.toLowerCase()));
        logger.debug(`[query] State filter: ${beforeCount} → ${items.length} items`);
    }
    if (filters?.severities && filters.severities.length > 0) {
        const normalizedSeverities = filters.severities.map((s) => s.toLowerCase());
        const beforeCount = items.length;
        items = items.filter((item) => item.severity && normalizedSeverities.includes(item.severity.toLowerCase()));
        logger.debug(`[query] Severity filter: ${beforeCount} → ${items.length} items`);
    }

    // Detect changes
    logger.debug(`[query] Detecting changes...`);
    let changes = oldCache
        ? detectChanges(oldCache, items)
        : items.map((item) => ({
              type: "new" as const,
              id: item.id,
              changes: ["Initial load"],
              newData: {
                  id: item.id,
                  changed: item.changed,
                  rev: item.rev,
                  title: item.title,
                  state: item.state,
                  severity: item.severity,
                  assignee: item.assignee,
                  url: item.url,
              },
          }));

    // Filter changes by date range if specified
    if (filters?.changesFrom || filters?.changesTo) {
        changes = changes.filter((change) => {
            const changeDate = new Date(change.newData.changed);
            if (filters.changesFrom && changeDate < filters.changesFrom) return false;
            if (filters.changesTo && changeDate > filters.changesTo) return false;
            return true;
        });
    }

    // Save to global cache (including query-level category/taskFolders if provided)
    const cacheData: QueryCache = {
        items: items.map((item) => ({
            id: item.id,
            changed: item.changed,
            rev: item.rev,
            title: item.title,
            state: item.state,
            severity: item.severity,
            assignee: item.assignee,
            createdAt: item.created,
            createdBy: item.createdBy,
            changedBy: item.changedBy,
            url: item.url,
        })),
        fetchedAt: new Date().toISOString(),
        // Store query-level settings for work item downloads
        category: category ?? rawCache?.category,
        taskFolders: taskFolders ?? rawCache?.taskFolders,
    };
    await saveGlobalCache("query", queryId, cacheData);

    // Output
    switch (format) {
        case "ai":
            console.log(formatAI(queryId, items, oldCache ? changes : [], oldCacheTime));
            break;
        case "md":
            console.log(formatMD(items));
            break;
        case "json":
            console.log(formatJSON({ items, changes: oldCache ? changes : [] }));
            break;
    }

    // Download all work items if requested
    if (downloadWorkitems && items.length > 0) {
        if (!workItemHandler) {
            throw new Error("Work item handler not available. Cannot download work items.");
        }

        // Use cached query settings as defaults if not explicitly provided
        const effectiveCategory = cacheData.category;
        const effectiveTaskFolders = cacheData.taskFolders ?? false;

        // Build metadata map from fresh query results for smart cache comparison
        const queryMetadata = new Map<number, QueryItemMetadata>(
            items.map((item) => [item.id, { id: item.id, changed: item.changed, rev: item.rev }])
        );

        log(
            `\nDownloading ${items.length} work items${effectiveCategory ? ` to category: ${effectiveCategory}` : ""}${effectiveTaskFolders ? " (with task folders)" : ""}...\n`
        );
        const ids = items.map((item) => item.id).join(",");
        // Pass queryMetadata for smart comparison (ignores forceRefresh when metadata available)
        await workItemHandler(ids, format, false, effectiveCategory, effectiveTaskFolders, queryMetadata, { comments: true });
    }
}

// ============= Command Registration =============

/**
 * Register the query command on the program
 */
export function registerQueryCommand(program: Command): void {
    program
        .command("query <input>")
        .description("Run an Azure DevOps query and display results")
        .option("-f, --format <format>", "Output format (ai, md, json)", "ai")
        .option("--force", "Force refresh, ignore cache")
        .option("--state <states>", "Filter by state (comma-separated)")
        .option("--severity <sev>", "Filter by severity (comma-separated)")
        .option("--changes-from <date>", "Show changes from this date")
        .option("--changes-to <date>", "Show changes up to this date")
        .option("--download-workitems", "Download all work items to tasks/")
        .option("--category <name>", "Save to tasks/<category>/")
        .option("--task-folders", "Save in tasks/<id>/ subfolder")
        .action(async (input: string, options: QueryOptions) => {
            // Parse filters from options
            const filters: QueryFilters = {};

            if (options.state) {
                filters.states = options.state
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
            if (options.severity) {
                filters.severities = options.severity
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
            if (options.changesFrom) {
                const d = new Date(options.changesFrom);
                if (!Number.isNaN(d.getTime())) filters.changesFrom = d;
            }
            if (options.changesTo) {
                const d = new Date(options.changesTo);
                if (!Number.isNaN(d.getTime())) filters.changesTo = d;
            }

            await handleQuery(
                input,
                options.format,
                options.force ?? false,
                filters,
                options.downloadWorkitems,
                options.category,
                options.taskFolders
            );
        });
}
