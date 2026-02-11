/**
 * Azure DevOps CLI Tool - Workitem Command
 *
 * Fetches work item(s) by ID or URL, with caching and output formatting.
 * Exports handleWorkItem for use by other commands (e.g., query --download-workitems).
 */

import { Api } from "@app/azure-devops/api";
import {
    formatJSON,
    loadGlobalCache,
    saveGlobalCache,
    WORKITEM_FRESHNESS_MINUTES,
} from "@app/azure-devops/cache";
import type {
    OutputFormat,
    QueryItemMetadata,
    WorkItemCache,
    WorkItemFull,
    WorkItemSettings,
} from "@app/azure-devops/types";
import {
    extractWorkItemIds,
    findTaskFile,
    findTaskFileAnywhere,
    getRelativeTime,
    getTaskFilePath,
    getTasksDir,
    htmlToMarkdown,
    parseRelations,
    requireConfig,
} from "@app/azure-devops/utils";
import logger, { consoleLog } from "@app/logger";
import type { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

// Silent mode for JSON output - suppresses progress messages
let silentMode = false;
const log = (msg: string) => {
    if (!silentMode) consoleLog.info(msg);
};

// ============= Output Formatters =============

function formatWorkItemAI(item: WorkItemFull, taskPath: string, cacheTime?: Date): string {
    const lines: string[] = [];

    lines.push(`# Work Item #${item.id}`);
    lines.push("");
    lines.push(`**${item.title}**`);
    lines.push("");
    if (cacheTime) {
        lines.push(`From cache (${getRelativeTime(cacheTime)}) - use --force to refresh`);
    }
    lines.push(`JSON: ${taskPath}`);
    lines.push(`Markdown: ${taskPath.replace(".json", ".md")}`);
    lines.push("");
    lines.push("## Details");
    lines.push(`- State: ${item.state}`);
    lines.push(`- Severity: ${item.severity || "N/A"}`);
    lines.push(`- Assignee: ${item.assignee || "unassigned"}`);
    lines.push(`- Tags: ${item.tags || "none"}`);
    lines.push(`- Created: ${item.created} by ${item.createdBy}`);
    lines.push(`- Last Changed: ${item.changed}`);

    if (item.description) {
        lines.push("");
        lines.push("## Description");
        const mdDesc = htmlToMarkdown(item.description);
        lines.push(mdDesc.slice(0, 500) + (mdDesc.length > 500 ? "..." : ""));
    }

    if (item.comments.length > 0) {
        lines.push("");
        lines.push(`## Comments (${item.comments.length})`);
        for (const comment of item.comments.slice(-5)) {
            lines.push("");
            lines.push(`**${comment.author}** (${new Date(comment.date).toLocaleDateString()}):`);
            const mdComment = htmlToMarkdown(comment.text);
            lines.push(mdComment.slice(0, 300) + (mdComment.length > 300 ? "..." : ""));
        }
    }

    if (item.relations && item.relations.length > 0) {
        lines.push("");
        lines.push(`## Related Items (${item.relations.length})`);

        const parsed = parseRelations(item.relations);
        if (parsed.parent) {
            lines.push(`- **Parent**: #${parsed.parent}`);
        }
        if (parsed.children.length > 0) {
            lines.push(`- **Children**: ${parsed.children.map((id) => `#${id}`).join(", ")}`);
        }
        if (parsed.related.length > 0) {
            lines.push(`- **Related**: ${parsed.related.map((id) => `#${id}`).join(", ")}`);
        }
        if (parsed.other.length > 0) {
            lines.push(`- **Other links**: ${parsed.other.length} (attachments, hyperlinks, etc.)`);
        }
    }

    return lines.join("\n");
}

function generateWorkItemMarkdown(item: WorkItemFull): string {
    const lines: string[] = [];

    lines.push(`# #${item.id}: ${item.title}`);
    lines.push("");
    lines.push("## Details");
    lines.push("");
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| State | ${item.state} |`);
    lines.push(`| Severity | ${item.severity || "N/A"} |`);
    lines.push(`| Assignee | ${item.assignee || "Unassigned"} |`);
    lines.push(`| Tags | ${item.tags || "None"} |`);
    lines.push(
        `| Created | ${item.created ? new Date(item.created).toLocaleString() : "N/A"} by ${item.createdBy || "Unknown"} |`
    );
    lines.push(`| Last Changed | ${item.changed ? new Date(item.changed).toLocaleString() : "N/A"} |`);
    lines.push(`| URL | ${item.url} |`);

    if (item.description) {
        lines.push("");
        lines.push("## Description");
        lines.push("");
        lines.push(htmlToMarkdown(item.description));
    }

    if (item.relations && item.relations.length > 0) {
        const parsed = parseRelations(item.relations);
        lines.push("");
        lines.push("## Related Items");
        lines.push("");
        if (parsed.parent) {
            lines.push(`- **Parent**: #${parsed.parent}`);
        }
        if (parsed.children.length > 0) {
            lines.push(`- **Children**: ${parsed.children.map((id) => `#${id}`).join(", ")}`);
        }
        if (parsed.related.length > 0) {
            lines.push(`- **Related**: ${parsed.related.map((id) => `#${id}`).join(", ")}`);
        }
    }

    if (item.comments.length > 0) {
        lines.push("");
        lines.push(`## Comments (${item.comments.length})`);
        lines.push("");
        for (const comment of item.comments) {
            lines.push(`### ${comment.author} - ${new Date(comment.date).toLocaleString()}`);
            lines.push("");
            lines.push(htmlToMarkdown(comment.text));
            lines.push("");
        }
    }

    return lines.join("\n");
}

// ============= Main Handler =============

/**
 * Handle work item command - fetch work item(s) by ID or URL
 *
 * @param input - Work item ID(s) or URL(s), comma-separated
 * @param format - Output format (ai, md, json)
 * @param forceRefresh - Force refresh, ignore cache
 * @param categoryArg - Category subdirectory for task files
 * @param taskFoldersArg - Use task subfolders (<id>/<id>-slug.json)
 * @param queryMetadata - Optional metadata from query for smart cache comparison
 */
export async function handleWorkItem(
    input: string,
    format: OutputFormat,
    forceRefresh: boolean,
    categoryArg?: string,
    taskFoldersArg?: boolean,
    queryMetadata?: Map<number, QueryItemMetadata>,
    fetchOptions?: { comments?: boolean; updates?: boolean }
): Promise<void> {
    silentMode = format === "json";
    logger.debug(
        `[workitem] Starting with input: ${input}, force=${forceRefresh}, category=${categoryArg}, taskFolders=${taskFoldersArg}`
    );

    const config = requireConfig();
    logger.debug(`[workitem] Config loaded: org=${config.org}, project=${config.project}`);
    const api = new Api(config);
    const ids = extractWorkItemIds(input);
    logger.debug(`[workitem] Extracted ${ids.length} work item IDs: ${ids.join(", ")}`);
    const results: WorkItemFull[] = [];
    const cacheTimes: Map<number, Date> = new Map();
    const settingsMap: Map<number, WorkItemSettings> = new Map();
    let skippedCount = 0;
    let downloadedCount = 0;

    // Phase 1: Cache check — partition into cached vs needs-fetch
    const needsFetch: number[] = [];
    const cachedResults: Map<number, WorkItemFull> = new Map();
    const existingFilePaths: Map<number, string | null> = new Map();

    for (const id of ids) {
        logger.debug(`[workitem] Processing work item #${id}`);
        const cache = await loadGlobalCache<WorkItemCache>("workitem", String(id));
        logger.debug(`[workitem] #${id} cache: ${cache ? `found (fetched ${cache.fetchedAt})` : "not found"}`);

        const existingFile = findTaskFileAnywhere(id, "json");
        logger.debug(`[workitem] #${id} existing file: ${existingFile ? existingFile.path : "none"}`);

        let finalCategory: string | undefined;
        let finalTaskFolder: boolean;

        if (existingFile) {
            finalCategory = existingFile.category;
            finalTaskFolder = existingFile.inTaskFolder;
        } else {
            finalCategory = categoryArg ?? cache?.category;
            finalTaskFolder = taskFoldersArg ?? cache?.taskFolder ?? false;
        }

        settingsMap.set(id, { category: finalCategory, taskFolder: finalTaskFolder });

        const tasksDir = finalTaskFolder ? `${getTasksDir(finalCategory)}/${id}` : getTasksDir(finalCategory);
        if (!existsSync(tasksDir)) {
            mkdirSync(tasksDir, { recursive: true });
        }

        const existingJsonPath = existingFile?.path || null;
        existingFilePaths.set(id, existingJsonPath);

        if (queryMetadata && cache && existingJsonPath && existsSync(existingJsonPath)) {
            const freshMeta = queryMetadata.get(id);
            if (freshMeta && freshMeta.changed === cache.changed && freshMeta.rev === cache.rev) {
                logger.debug(`[workitem] #${id} unchanged (rev=${cache.rev}), using cache`);
                const cachedItem = JSON.parse(readFileSync(existingJsonPath, "utf-8")) as WorkItemFull;
                cachedResults.set(id, cachedItem);
                cacheTimes.set(id, new Date(cache.fetchedAt));
                skippedCount++;
                continue;
            }
            logger.debug(`[workitem] #${id} changed since cache (cache rev=${cache.rev}, fresh rev=${freshMeta?.rev})`);
        }

        if (!forceRefresh && !queryMetadata && cache && existingJsonPath && existsSync(existingJsonPath)) {
            const cacheDate = new Date(cache.fetchedAt);
            const ageMinutes = (Date.now() - cacheDate.getTime()) / 60000;
            if (ageMinutes < WORKITEM_FRESHNESS_MINUTES) {
                logger.debug(`[workitem] #${id} cache fresh (${ageMinutes.toFixed(1)} min old), using cache`);
                const cachedItem = JSON.parse(readFileSync(existingJsonPath, "utf-8")) as WorkItemFull;
                cachedResults.set(id, cachedItem);
                cacheTimes.set(id, cacheDate);
                skippedCount++;
                continue;
            }
            logger.debug(`[workitem] #${id} cache expired (${ageMinutes.toFixed(1)} min old)`);
        }

        needsFetch.push(id);
    }

    // Phase 2: Batch fetch fields+relations + parallel comments
    const fetchedItems: Map<number, WorkItemFull> = new Map();

    if (needsFetch.length > 0) {
        logger.debug(`[workitem] Batch fetching ${needsFetch.length} work items...`);

        const fetched = await api.getWorkItems(needsFetch, {
            comments: fetchOptions?.comments !== false,
            updates: fetchOptions?.updates,
        });

        for (const id of needsFetch) {
            const item = fetched.get(id);
            if (!item) {
                logger.warn(`[workitem] #${id} not found in batch response, skipping`);
                continue;
            }
            fetchedItems.set(id, item);
            downloadedCount++;
        }
    }

    // Phase 3: Save fetched items to disk + update cache
    for (const [id, item] of fetchedItems) {
        const existingJsonPath = existingFilePaths.get(id) ?? null;
        const settings = settingsMap.get(id)!;

        const jsonPath = getTaskFilePath(id, item.title, "json", settings.category, settings.taskFolder);
        const mdPath = getTaskFilePath(id, item.title, "md", settings.category, settings.taskFolder);

        const targetDir = dirname(jsonPath);
        if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
        }

        if (existingJsonPath && existingJsonPath !== jsonPath) {
            try {
                const existingMdPath = existingJsonPath.replace(".json", ".md");
                if (existsSync(existingJsonPath)) unlinkSync(existingJsonPath);
                if (existsSync(existingMdPath)) unlinkSync(existingMdPath);
                const oldDir = dirname(existingJsonPath);
                if (existsSync(oldDir) && readdirSync(oldDir).length === 0) {
                    rmdirSync(oldDir);
                }
            } catch {
                /* ignore */
            }
        }

        logger.debug(`[workitem] #${id} saving JSON: ${jsonPath}`);
        writeFileSync(jsonPath, JSON.stringify(item, null, 2));
        logger.debug(`[workitem] #${id} saving MD: ${mdPath}`);
        writeFileSync(mdPath, generateWorkItemMarkdown(item));

        logger.debug(`[workitem] #${id} updating global cache`);
        const cacheData: WorkItemCache = {
            id: item.id,
            rev: item.rev,
            changed: item.changed,
            title: item.title,
            state: item.state,
            commentCount: item.comments.length,
            fetchedAt: new Date().toISOString(),
            category: settings.category,
            taskFolder: settings.taskFolder,
        };
        await saveGlobalCache("workitem", String(id), cacheData);
    }

    // Build results in original ID order
    for (const id of ids) {
        const cached = cachedResults.get(id);
        if (cached) {
            results.push(cached);
            continue;
        }
        const fetched = fetchedItems.get(id);
        if (fetched) {
            results.push(fetched);
        }
    }

    // Log download summary
    if (queryMetadata && ids.length > 1) {
        log(`   ${skippedCount} cached (unchanged), ${downloadedCount} downloaded`);
    }

    // Output
    for (let i = 0; i < results.length; i++) {
        const item = results[i];
        const settings = settingsMap.get(item.id);
        const taskPath =
            findTaskFile(item.id, "json", settings?.category) ||
            getTaskFilePath(item.id, item.title, "json", settings?.category, settings?.taskFolder);
        const cacheTime = cacheTimes.get(item.id);

        if (i > 0) console.log("\n---\n");

        switch (format) {
            case "ai":
                console.log(formatWorkItemAI(item, taskPath, cacheTime));
                break;
            case "md":
                console.log(
                    `# ${item.title}\n\n${item.description || "No description"}\n\n## Comments\n${item.comments.map((c) => `- **${c.author}**: ${c.text}`).join("\n")}`
                );
                break;
            case "json":
                console.log(formatJSON(item));
                break;
        }
    }
}

// ============= Command Registration =============

/**
 * Register the workitem command on the Commander program
 */
export function registerWorkitemCommand(program: Command): void {
    program
        .command("workitem <input>")
        .alias("wi")
        .description("Fetch work item(s) by ID or URL")
        .option("-f, --format <format>", "Output format (ai, md, json)", "ai")
        .option("--force", "Force refresh, ignore cache")
        .option("--category <name>", "Save to tasks/<category>/")
        .option("--task-folders", "Save in tasks/<id>/ subfolder")
        .action(
            async (
                input: string,
                options: { format: OutputFormat; force?: boolean; category?: string; taskFolders?: boolean }
            ) => {
                await handleWorkItem(
                    input,
                    options.format,
                    options.force ?? false,
                    options.category,
                    options.taskFolders
                );
            }
        );
}
