/**
 * Azure DevOps CLI Tool - Utility Functions
 *
 * This file contains utility functions extracted from the main index.ts:
 * - HTML to Markdown conversion
 * - String utilities (slugify, getRelativeTime)
 * - Configuration loading and management
 * - Task file path utilities
 * - URL parsers
 * - Work item utilities
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type {
    AzureConfig,
    AzureConfigWithTimeLog,
    FoundTaskFile,
    ParsedUrl,
    Relation,
    ParsedRelations,
    CacheEntry,
    WorkItem,
    WorkItemFull,
    ChangeInfo,
    WorkItemTypeDefinition,
    UsedValuesCache,
    WorkItemTemplate,
    WorkItemType,
    QueryInfo,
    TimeLogUser,
} from "@app/azure-devops/types";

// ============= HTML to Markdown =============

const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
});
turndown.use(gfm);

/**
 * Convert HTML content to clean Markdown
 */
export function htmlToMarkdown(html: string): string {
    if (!html) return "";
    return turndown.turndown(html).trim();
}

// ============= String Utilities =============

export function slugify(title: string): string {
    return title
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
        .replace(/[^a-zA-Z0-9]+/g, "-") // Replace non-alphanumeric with dash
        .replace(/^-+|-+$/g, "") // Trim dashes
        .slice(0, 50); // Limit length
}

export function getRelativeTime(date: Date): string {
    const ageMinutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (ageMinutes < 1) return "just now";
    if (ageMinutes === 1) return "1 minute ago";
    if (ageMinutes < 60) return `${ageMinutes} minutes ago`;
    const ageHours = Math.round(ageMinutes / 60);
    if (ageHours === 1) return "1 hour ago";
    if (ageHours < 24) return `${ageHours} hours ago`;
    const ageDays = Math.round(ageHours / 24);
    return `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
}

// ============= Configuration Functions =============

/**
 * Search for config file starting from cwd, up to 3 parent levels
 */
export function findConfigPath(): string | null {
    const configName = ".claude/azure/config.json";
    let currentDir = process.cwd();

    for (let i = 0; i < 4; i++) {
        // current + 3 levels up
        const configPath = join(currentDir, configName);
        if (existsSync(configPath)) {
            return configPath;
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) break; // reached root
        currentDir = parentDir;
    }
    return null;
}

/**
 * Get the config directory for the current project (in cwd)
 */
export function getLocalConfigDir(): string {
    return join(process.cwd(), ".claude/azure");
}

/**
 * Get the tasks directory (always in cwd), optionally with category subdirectory
 */
export function getTasksDir(category?: string): string {
    const base = join(process.cwd(), ".claude/azure/tasks");
    return category ? join(base, category) : base;
}

/**
 * Load config from file or return null if not found
 */
export function loadConfig(): AzureConfig | null {
    const configPath = findConfigPath();
    if (!configPath) return null;

    try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
        return null;
    }
}

/**
 * Require config or exit with helpful error
 */
export function requireConfig(): AzureConfig {
    const config = loadConfig();
    if (!config) {
        console.error(`
❌ No Azure DevOps configuration found.

Run --configure with any Azure DevOps URL from your project:

  tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
  tools azure-devops --configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."

This will create .claude/azure/config.json in the current directory.
`);
        process.exit(1);
    }
    return config;
}

/**
 * Load config with TimeLog settings or exit with helpful error
 */
export function requireTimeLogConfig(): AzureConfigWithTimeLog {
    const config = loadConfig() as AzureConfigWithTimeLog | null;
    if (!config) {
        console.error(`
❌ No Azure DevOps configuration found.

Run configure with any Azure DevOps URL from your project:

  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
`);
        process.exit(1);
    }

    if (!config.orgId) {
        console.error(`
❌ Organization ID not found in config.

Re-run configure to update your config:

  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems" --force
`);
        process.exit(1);
    }

    if (!config.timelog?.functionsKey) {
        console.error(`
❌ TimeLog configuration not found.

Run the auto-configure command to fetch TimeLog settings:

  tools azure-devops timelog configure

This will automatically fetch the API key from Azure DevOps Extension Data API.
`);
        process.exit(1);
    }

    return config;
}

/**
 * Get current user for TimeLog or exit with helpful error
 */
export function requireTimeLogUser(config: AzureConfigWithTimeLog): TimeLogUser {
    const user = config.timelog?.defaultUser;
    if (!user) {
        console.error(`
❌ TimeLog user not configured.

Add defaultUser to .claude/azure/config.json timelog section:

"timelog": {
  "functionsKey": "...",
  "defaultUser": {
    "userId": "<your-azure-ad-object-id>",
    "userName": "<Your Display Name>",
    "userEmail": "<your-email@example.com>"
  }
}
`);
        process.exit(1);
    }
    return user;
}

// ============= Task File Utilities =============

/**
 * Find task file in a specific directory (flat, not in task subfolder)
 */
export function findTaskFileFlat(id: number, ext: string, dir: string): string | null {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir);
    const match = files.find((f) => f.startsWith(`${id}-`) && f.endsWith(`.${ext}`));
    return match ? join(dir, match) : null;
}

/**
 * Find task file in task subfolder (<dir>/<id>/<id>-...)
 */
export function findTaskFileInFolder(id: number, ext: string, dir: string): string | null {
    const taskFolderPath = join(dir, String(id));
    if (!existsSync(taskFolderPath)) return null;
    const files = readdirSync(taskFolderPath);
    const match = files.find((f) => f.startsWith(`${id}-`) && f.endsWith(`.${ext}`));
    return match ? join(taskFolderPath, match) : null;
}

/**
 * Find task file - checks both flat and folder structure
 */
export function findTaskFile(id: number, ext: string, category?: string): string | null {
    const tasksDir = getTasksDir(category);
    // Check flat first, then folder
    return findTaskFileFlat(id, ext, tasksDir) || findTaskFileInFolder(id, ext, tasksDir);
}

/**
 * Search for task file in any location (root, categories, with/without task folders)
 */
export function findTaskFileAnywhere(id: number, ext: string): FoundTaskFile | null {
    const baseTasksDir = getTasksDir();
    if (!existsSync(baseTasksDir)) return null;

    // Check root flat
    const rootFlat = findTaskFileFlat(id, ext, baseTasksDir);
    if (rootFlat) return { path: rootFlat, inTaskFolder: false };

    // Check root task folder
    const rootFolder = findTaskFileInFolder(id, ext, baseTasksDir);
    if (rootFolder) return { path: rootFolder, inTaskFolder: true };

    // Check category subdirectories
    const entries = readdirSync(baseTasksDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== String(id)) {
            const categoryDir = join(baseTasksDir, entry.name);

            // Check flat in category
            const catFlat = findTaskFileFlat(id, ext, categoryDir);
            if (catFlat) return { path: catFlat, category: entry.name, inTaskFolder: false };

            // Check task folder in category
            const catFolder = findTaskFileInFolder(id, ext, categoryDir);
            if (catFolder) return { path: catFolder, category: entry.name, inTaskFolder: true };
        }
    }

    return null;
}

export function getTaskFilePath(
    id: number,
    title: string,
    ext: string,
    category?: string,
    useTaskFolder?: boolean
): string {
    const slug = slugify(title);
    const base = getTasksDir(category);
    if (useTaskFolder) {
        return join(base, String(id), `${id}-${slug}.${ext}`);
    }
    return join(base, `${id}-${slug}.${ext}`);
}

// ============= URL Parsers =============

/**
 * Check if input looks like a GUID or URL (not a query name)
 */
export function isQueryIdOrUrl(input: string): boolean {
    // GUID pattern
    if (/^[a-f0-9-]{36}$/i.test(input)) return true;
    // URL pattern
    if (input.includes("query/")) return true;
    // Bare GUID without dashes
    if (/^[a-f0-9]{32}$/i.test(input)) return true;
    return false;
}

export function extractQueryId(input: string): string {
    const match = input.match(/query\/([a-f0-9-]+)/i) || input.match(/^([a-f0-9-]+)$/i);
    if (!match) throw new Error(`Invalid query URL/ID: ${input}`);
    return match[1];
}

// ============= Fuzzy String Matching =============

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy matching query names
 */
export function levenshteinDistance(a: string, b: string): number {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    if (aLower === bLower) return 0;
    if (aLower.length === 0) return bLower.length;
    if (bLower.length === 0) return aLower.length;

    const matrix: number[][] = [];

    // Initialize matrix
    for (let i = 0; i <= bLower.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= aLower.length; j++) {
        matrix[0][j] = j;
    }

    // Fill matrix
    for (let i = 1; i <= bLower.length; i++) {
        for (let j = 1; j <= aLower.length; j++) {
            const cost = bLower[i - 1] === aLower[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1, // deletion
                matrix[i][j - 1] + 1, // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }

    return matrix[bLower.length][aLower.length];
}

/**
 * Calculate similarity score (0-1, higher is better)
 */
export function similarityScore(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Find the best matching query by name from a list of queries
 * Returns the query if a good match is found, null otherwise
 * @param recentQueryIds - Optional set of query IDs that have been recently used (get 0.15 score boost)
 */
export function findQueryByName(
    searchName: string,
    queries: QueryInfo[],
    recentQueryIds?: Set<string>
): { query: QueryInfo; score: number; alternatives: QueryInfo[] } | null {
    // Filter to non-folder queries only
    const actualQueries = queries.filter((q) => !q.isFolder);

    if (actualQueries.length === 0) return null;

    // Calculate scores for all queries
    const scored = actualQueries.map((q) => {
        // Check exact match first (case-insensitive)
        if (q.name.toLowerCase() === searchName.toLowerCase()) {
            return { query: q, score: 1.0 };
        }

        // Check if search term is contained in query name
        const containsScore = q.name.toLowerCase().includes(searchName.toLowerCase())
            ? 0.8 + (searchName.length / q.name.length) * 0.15
            : 0;

        // Calculate Levenshtein similarity
        const levScore = similarityScore(searchName, q.name);

        // Also check against full path
        const pathScore = similarityScore(searchName, q.path) * 0.8;

        // Take the best score
        let finalScore = Math.max(containsScore, levScore, pathScore);

        // Boost score for recently-used queries (add 0.15 to favor them)
        if (recentQueryIds?.has(q.id)) {
            finalScore = Math.min(1.0, finalScore + 0.15);
        }

        return { query: q, score: finalScore };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Get top match
    const best = scored[0];

    // If best score is too low, no good match
    if (best.score < 0.3) return null;

    // Get alternatives (other high-scoring matches)
    const alternatives = scored
        .slice(1, 4)
        .filter((s) => s.score >= 0.3)
        .map((s) => s.query);

    return {
        query: best.query,
        score: best.score,
        alternatives,
    };
}

export function extractWorkItemIds(input: string): number[] {
    const parts = input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const ids: number[] = [];

    for (const part of parts) {
        const match = part.match(/workItems?\/(\d+)/i) || part.match(/edit\/(\d+)/i) || part.match(/^(\d+)$/);
        if (!match) throw new Error(`Invalid work item URL/ID: ${part}`);
        ids.push(parseInt(match[1], 10));
    }

    return ids;
}

export function extractDashboardId(input: string): string {
    const match = input.match(/dashboard\/([a-f0-9-]+)/i) || input.match(/^([a-f0-9-]+)$/i);
    if (!match) throw new Error(`Invalid dashboard URL/ID: ${input}`);
    return match[1];
}

export function parseAzureDevOpsUrl(url: string): ParsedUrl {
    const devAzureMatch = url.match(/https:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)/i);
    if (devAzureMatch) {
        return {
            org: `https://dev.azure.com/${devAzureMatch[1]}`,
            project: decodeURIComponent(devAzureMatch[2]),
        };
    }

    const vsMatch = url.match(/https:\/\/([^\.]+)\.visualstudio\.com\/([^\/]+)/i);
    if (vsMatch) {
        return {
            org: `https://dev.azure.com/${vsMatch[1]}`,
            project: decodeURIComponent(vsMatch[2]),
        };
    }

    throw new Error(
        `Could not parse Azure DevOps URL: ${url}\n\nSupported formats:\n  https://dev.azure.com/{org}/{project}/...\n  https://{org}.visualstudio.com/{project}/...`
    );
}

// ============= Work Item Utilities =============

export function parseRelations(relations: Relation[]): ParsedRelations {
    const result: ParsedRelations = { children: [], related: [], other: [] };

    for (const rel of relations) {
        const idMatch = rel.url.match(/workItems\/(\d+)/i);
        if (!idMatch) {
            result.other.push(rel.rel);
            continue;
        }
        const id = parseInt(idMatch[1], 10);

        if (rel.rel === "System.LinkTypes.Hierarchy-Reverse") {
            result.parent = id;
        } else if (rel.rel === "System.LinkTypes.Hierarchy-Forward") {
            result.children.push(id);
        } else if (rel.rel.includes("Related")) {
            result.related.push(id);
        } else {
            result.related.push(id);
        }
    }

    return result;
}

export function detectChanges(oldItems: CacheEntry[], newItems: WorkItem[]): ChangeInfo[] {
    const changes: ChangeInfo[] = [];
    const oldMap = new Map(oldItems.map((item) => [item.id, item]));

    for (const newItem of newItems) {
        const oldItem = oldMap.get(newItem.id);
        const newEntry: CacheEntry = {
            id: newItem.id,
            changed: newItem.changed,
            rev: newItem.rev,
            title: newItem.title,
            state: newItem.state,
            severity: newItem.severity,
            assignee: newItem.assignee,
            url: newItem.url,
        };

        if (!oldItem) {
            changes.push({ type: "new", id: newItem.id, changes: ["New work item"], newData: newEntry });
        } else if (newItem.changed > oldItem.changed || newItem.rev > oldItem.rev) {
            const changeList: string[] = [];
            if (oldItem.state !== newItem.state) {
                changeList.push(`State: ${oldItem.state} → ${newItem.state}`);
            }
            if (oldItem.assignee !== newItem.assignee) {
                changeList.push(`Assignee: ${oldItem.assignee || "unassigned"} → ${newItem.assignee || "unassigned"}`);
            }
            if (oldItem.severity !== newItem.severity) {
                changeList.push(`Severity: ${oldItem.severity} → ${newItem.severity}`);
            }
            if (oldItem.title !== newItem.title) {
                changeList.push(`Title changed`);
            }
            if (changeList.length === 0) {
                changeList.push("Updated (comments or other fields)");
            }
            changes.push({ type: "updated", id: newItem.id, changes: changeList, oldData: oldItem, newData: newEntry });
        }
    }

    return changes;
}

// ============= Field Discovery Functions =============

/**
 * Build a simplified field schema from a work item type definition
 * Returns a map of field reference names to their metadata
 */
// Standard Azure DevOps field values (the API doesn't return these in type definition)
const STANDARD_FIELD_VALUES: Record<string, string[]> = {
    "Microsoft.VSTS.Common.Severity": ["A - Critical", "B - High", "C - Medium", "D - Low"],
    "Microsoft.VSTS.Common.Priority": ["1", "2", "3", "4"],
    "Microsoft.VSTS.Common.ValueArea": ["Business", "Architectural"],
    "Microsoft.VSTS.Common.Risk": ["1 - High", "2 - Medium", "3 - Low"],
};

export function buildFieldSchema(
    typeDef: WorkItemTypeDefinition
): Map<
    string,
    { name: string; required: boolean; allowedValues?: string[]; defaultValue?: string; helpText?: string }
> {
    const schema = new Map<
        string,
        { name: string; required: boolean; allowedValues?: string[]; defaultValue?: string; helpText?: string }
    >();

    // Use fieldInstances if available, otherwise fields
    const fields = typeDef.fieldInstances || typeDef.fields || [];

    for (const field of fields) {
        // Use API allowedValues if present, otherwise fall back to standard values
        const allowedValues = field.allowedValues || STANDARD_FIELD_VALUES[field.referenceName];

        schema.set(field.referenceName, {
            name: field.name,
            required: field.alwaysRequired || false,
            allowedValues,
            defaultValue: field.defaultValue,
            helpText: field.helpText,
        });
    }

    // Add states as a pseudo-field
    if (typeDef.states && typeDef.states.length > 0) {
        schema.set("System.State", {
            name: "State",
            required: true,
            allowedValues: typeDef.states.map((s) => s.name),
            defaultValue: typeDef.states.find((s) => s.category === "Proposed")?.name,
        });
    }

    return schema;
}

/**
 * Extract commonly used values from a list of work items
 * This provides recommendations based on actual usage patterns
 */
export function extractUsedValues(items: WorkItem[], project: string, queryId?: string): UsedValuesCache {
    const areas = new Set<string>();
    const iterations = new Set<string>();
    const severities = new Set<string>();
    const tagCounts = new Map<string, number>();
    const assignees = new Set<string>();
    const parents = new Map<number, string>(); // id -> title

    for (const item of items) {
        // Note: WorkItem doesn't have areaPath/iterationPath directly
        // These would need to be fetched from full work item details
        // For now, we extract what's available

        if (item.severity) {
            severities.add(item.severity);
        }

        if (item.assignee) {
            assignees.add(item.assignee);
        }

        if (item.tags) {
            for (const tag of item.tags
                .split(";")
                .map((t) => t.trim())
                .filter(Boolean)) {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
        }
    }

    // Sort tags by frequency
    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

    return {
        project,
        queryId,
        fetchedAt: new Date().toISOString(),
        areas: [...areas],
        iterations: [...iterations],
        severities: [...severities],
        tags: sortedTags,
        assignees: [...assignees],
        parents: [...parents.entries()].map(([id, title]) => ({ id, title })),
    };
}

/**
 * Extract used values from full work item details (includes area/iteration paths)
 */
export function extractUsedValuesFromFull(items: WorkItemFull[], project: string, queryId?: string): UsedValuesCache {
    const areas = new Set<string>();
    const iterations = new Set<string>();
    const severities = new Set<string>();
    const tagCounts = new Map<string, number>();
    const assignees = new Set<string>();
    const parents = new Map<number, string>();

    for (const item of items) {
        if (item.severity) severities.add(item.severity);
        if (item.assignee) assignees.add(item.assignee);

        // Extract area and iteration paths from rawFields
        if (item.rawFields) {
            const areaPath = item.rawFields["System.AreaPath"];
            const iterationPath = item.rawFields["System.IterationPath"];
            if (typeof areaPath === "string") areas.add(areaPath);
            if (typeof iterationPath === "string") iterations.add(iterationPath);
        }

        if (item.tags) {
            for (const tag of item.tags
                .split(";")
                .map((t) => t.trim())
                .filter(Boolean)) {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
        }

        // Extract parent from relations
        if (item.relations) {
            const parsed = parseRelations(item.relations);
            if (parsed.parent) {
                parents.set(parsed.parent, `Parent #${parsed.parent}`);
            }
        }
    }

    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

    return {
        project,
        queryId,
        fetchedAt: new Date().toISOString(),
        areas: [...areas],
        iterations: [...iterations],
        severities: [...severities],
        tags: sortedTags,
        assignees: [...assignees],
        parents: [...parents.entries()].map(([id, title]) => ({ id, title })),
    };
}

/**
 * Merge API field definitions with actual usage data to create rich hints
 */
export function mergeFieldsWithUsage(
    fieldSchema: Map<string, { name: string; required: boolean; allowedValues?: string[]; defaultValue?: string }>,
    usedValues: UsedValuesCache
): Record<
    string,
    {
        description: string;
        required?: boolean;
        allowedValues?: string[];
        usedValues?: string[];
        defaultValue?: string;
        examples?: string[];
    }
> {
    const hints: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    > = {};

    // Standard fields with their commonly used values
    const fieldMappings: Record<string, { usedKey: keyof UsedValuesCache; description: string }> = {
        "System.AreaPath": { usedKey: "areas", description: "Area path for categorization" },
        "System.IterationPath": { usedKey: "iterations", description: "Sprint/Iteration path" },
        "Microsoft.VSTS.Common.Severity": { usedKey: "severities", description: "Severity level" },
        "System.Tags": { usedKey: "tags", description: "Tags for filtering (semicolon-separated)" },
        "System.AssignedTo": { usedKey: "assignees", description: "Assignee email or display name" },
    };

    for (const [refName, schema] of fieldSchema) {
        const mapping = fieldMappings[refName];
        const usedVals = mapping ? (usedValues[mapping.usedKey] as string[]) : undefined;

        hints[refName] = {
            description: mapping?.description || schema.name,
            required: schema.required || undefined,
            allowedValues: schema.allowedValues,
            usedValues: usedVals?.length ? usedVals : undefined,
            defaultValue: schema.defaultValue,
            examples: usedVals?.slice(0, 3),
        };
    }

    return hints;
}

// ============= Template Generation Functions =============

/**
 * Transform API hints to template hint format
 */
function transformHintsForTemplate(
    hints: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    >
): WorkItemTemplate["_hints"] {
    const templateHints: WorkItemTemplate["_hints"] = {};

    // Map API field names to simple field names
    const fieldMapping: Record<string, string> = {
        "System.Title": "title",
        "System.Description": "description",
        "Microsoft.VSTS.Common.Severity": "severity",
        "System.AreaPath": "areaPath",
        "System.IterationPath": "iterationPath",
        "System.Tags": "tags",
        "System.AssignedTo": "assignedTo",
        "System.State": "state",
    };

    for (const [refName, hint] of Object.entries(hints)) {
        const simpleKey = fieldMapping[refName] || refName;
        templateHints[simpleKey] = hint;
    }

    // Always add title hint
    if (!templateHints["title"]) {
        templateHints["title"] = {
            description: "Brief title for the work item",
            required: true,
        };
    }

    return templateHints;
}

/**
 * Generate an empty work item template for a given type
 */
export function generateEmptyTemplate(
    type: WorkItemType,
    hints?: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    >
): WorkItemTemplate {
    return {
        $schema: "azure-devops-workitem-v1",
        type,
        fields: {
            title: "",
            description: "",
            severity: "",
            areaPath: "",
            iterationPath: "",
            tags: [],
            assignedTo: "",
        },
        relations: {
            parent: undefined,
            children: [],
            related: [],
        },
        _hints: hints ? transformHintsForTemplate(hints) : undefined,
        _source: {
            generatedAt: new Date().toISOString(),
        },
    };
}

/**
 * Infer work item type from title patterns
 */
function inferWorkItemType(title: string): WorkItemType | undefined {
    const lower = title.toLowerCase();
    if (lower.includes("bug") || lower.includes("fix") || lower.includes("error")) return "Bug";
    if (lower.includes("feature") || lower.includes("implement")) return "Feature";
    if (lower.includes("task")) return "Task";
    if (lower.includes("story") || lower.includes("user")) return "User Story";
    return undefined;
}

/**
 * Extract a description template from existing description
 * Preserves section structure but clears content
 */
function extractDescriptionTemplate(description?: string): string {
    if (!description) return "";

    // Convert HTML to markdown first
    const md = htmlToMarkdown(description);

    // Find section headers and preserve structure
    const lines = md.split("\n");
    const template: string[] = [];

    for (const line of lines) {
        if (line.startsWith("##") || line.startsWith("###")) {
            template.push(line);
            template.push("");
        }
    }

    // If no sections found, return empty string
    // (The API's helpText provides the appropriate template for new work items)
    if (template.length === 0) {
        return "";
    }

    return template.join("\n");
}

/**
 * Extract a display value from a raw Azure DevOps field value
 * Handles objects with displayName (users), strings, numbers, etc.
 */
function extractFieldValue(value: unknown): string | number | string[] | undefined {
    if (value === null || value === undefined) return undefined;

    // Handle user/identity objects (have displayName)
    if (typeof value === "object" && value !== null && "displayName" in value) {
        return (value as { displayName: string }).displayName;
    }

    // Handle arrays
    if (Array.isArray(value)) {
        return value.map((v) => String(v));
    }

    // Handle primitives
    if (typeof value === "string") return value;
    if (typeof value === "number") return value;

    return String(value);
}

/** Check if a string looks like a GUID */
function isGuid(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Generate a template pre-filled with values from an existing work item
 * Useful for creating similar work items
 *
 * Uses rawFields to extract ALL fields from the source item, including custom fields.
 * @param sourceItem - The work item to use as template
 * @param type - Optional work item type override
 * @param fieldSchema - Optional field schema from type definition (for allowedValues)
 */
export function generateTemplateFromWorkItem(
    sourceItem: WorkItemFull,
    type?: WorkItemType,
    fieldSchema?: Map<
        string,
        { name: string; required: boolean; allowedValues?: string[]; helpText?: string; defaultValue?: string }
    >
): WorkItemTemplate {
    const parsed = sourceItem.relations
        ? parseRelations(sourceItem.relations)
        : { parent: undefined, children: [], related: [] };
    const rawFields = sourceItem.rawFields || {};

    // Extract all field values from raw API response
    const fields: Record<string, unknown> = {
        title: "", // Empty - user should provide new title
        description: extractDescriptionTemplate(sourceItem.description),
    };

    // Known field mappings (Azure DevOps reference name -> template field name)
    const fieldMappings: Record<string, string> = {
        "System.AreaPath": "areaPath",
        "System.IterationPath": "iterationPath",
        "System.AssignedTo": "assignedTo",
        "System.Tags": "tags",
        "Microsoft.VSTS.Common.Severity": "severity",
        "Microsoft.VSTS.Common.Priority": "priority",
        "Microsoft.VSTS.Common.Activity": "activity",
        "Microsoft.VSTS.Scheduling.Effort": "effort",
        "Microsoft.VSTS.Scheduling.RemainingWork": "remainingWork",
        "Microsoft.VSTS.Scheduling.OriginalEstimate": "originalEstimate",
        "Microsoft.VSTS.Common.ValueArea": "valueArea",
        "Microsoft.VSTS.Common.Risk": "risk",
        "Microsoft.VSTS.Common.BusinessValue": "businessValue",
    };

    // Fields to skip (system/computed fields)
    const skipFields = new Set([
        "System.Title", // We set this to empty explicitly
        "System.Description", // We process this specially
        "System.Id",
        "System.Rev",
        "System.WorkItemType",
        "System.State",
        "System.Reason",
        "System.CreatedDate",
        "System.CreatedBy",
        "System.ChangedDate",
        "System.ChangedBy",
        "System.CommentCount",
        "System.TeamProject",
        "System.NodeName",
        "System.AreaId",
        "System.IterationId",
        "System.AreaLevel1",
        "System.AreaLevel2",
        "System.AreaLevel3",
        "System.IterationLevel1",
        "System.IterationLevel2",
        "System.IterationLevel3",
        "System.AuthorizedDate",
        "System.AuthorizedAs",
        "System.RevisedDate",
        "System.Watermark",
        "System.BoardColumn",
        "System.BoardColumnDone",
        "System.BoardLane",
        "System.Parent",
        "System.History", // Comment history
        "System.PersonId",
        "Microsoft.VSTS.Common.StateChangeDate", // Computed
    ]);

    // Hints for extracted fields
    const hints: Record<
        string,
        { description: string; required?: boolean; usedValues?: string[]; allowedValues?: string[] }
    > = {
        title: {
            description: "Title for the new work item",
            required: true,
        },
        description: {
            description: "Description template extracted from source work item",
        },
    };

    // Process all raw fields
    for (const [refName, rawValue] of Object.entries(rawFields)) {
        if (skipFields.has(refName)) continue;

        // Skip GUID-named custom fields (e.g., "Custom.32af3eb0-3fc8-4099-...")
        const parts = refName.split(".");
        const lastPart = parts[parts.length - 1];
        if (isGuid(lastPart)) continue;

        const value = extractFieldValue(rawValue);
        if (value === undefined || value === "") continue;

        // Map to known field name or use last part of reference name
        let fieldName = fieldMappings[refName];
        if (!fieldName) {
            // Extract custom field name: "Custom.Application" -> "application"
            fieldName = lastPart;
            // Convert to camelCase
            fieldName = fieldName.charAt(0).toLowerCase() + fieldName.slice(1);
        }

        // Handle tags specially (split into array)
        if (refName === "System.Tags" && typeof value === "string") {
            fields[fieldName] = value
                .split(";")
                .map((t) => t.trim())
                .filter(Boolean);
        } else {
            fields[fieldName] = value;
        }

        // Add hint for this field
        const valueStr = Array.isArray(value) ? value.join(", ") : String(value);
        const schemaField = fieldSchema?.get(refName);
        hints[fieldName] = {
            description: schemaField?.helpText || `Pre-filled from source work item (${refName})`,
            usedValues: [valueStr],
            allowedValues: schemaField?.allowedValues,
            required: schemaField?.required,
        };
    }

    // Add hints for fields that have allowedValues but weren't in the source item
    if (fieldSchema) {
        for (const [refName, schemaField] of fieldSchema) {
            if (skipFields.has(refName)) continue;
            if (schemaField.allowedValues && schemaField.allowedValues.length > 0) {
                const lastPart = refName.split(".").pop();
                if (!lastPart) continue;
                const fieldName = fieldMappings[refName] || lastPart.charAt(0).toLowerCase() + lastPart.slice(1);
                if (!hints[fieldName]) {
                    hints[fieldName] = {
                        description: schemaField.helpText || `Field from type definition (${refName})`,
                        allowedValues: schemaField.allowedValues,
                        required: schemaField.required,
                    };
                }
            }
        }
    }

    // Ensure parent hint is set
    if (parsed.parent) {
        hints["parent"] = {
            description: "Same parent as source work item",
            usedValues: [`${parsed.parent}`],
        };
    }

    return {
        $schema: "azure-devops-workitem-v1",
        type: type || inferWorkItemType(sourceItem.title) || "Task",
        fields,
        relations: {
            parent: parsed.parent,
            children: [],
            related: [],
        },
        _hints: hints,
        _source: {
            workItemId: sourceItem.id,
            generatedAt: new Date().toISOString(),
        },
    };
}

/**
 * Generate a template based on patterns from query results
 */
export function generateTemplateFromQuery(
    items: WorkItem[],
    type: WorkItemType,
    project: string,
    queryId: string,
    hints?: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    >
): WorkItemTemplate {
    const usedValues = extractUsedValues(items, project, queryId);

    return {
        $schema: "azure-devops-workitem-v1",
        type,
        fields: {
            title: "",
            description: "",
            severity: usedValues.severities[0] || "",
            areaPath: usedValues.areas[0] || "",
            iterationPath: usedValues.iterations[0] || "",
            tags: [],
            assignedTo: "",
        },
        relations: {
            parent: usedValues.parents[0]?.id,
            children: [],
            related: [],
        },
        _hints: {
            title: { description: "Brief title for the work item", required: true },
            severity: {
                description: "Severity level (from query data)",
                allowedValues: hints?.["Microsoft.VSTS.Common.Severity"]?.allowedValues,
                usedValues: usedValues.severities,
                examples: usedValues.severities.slice(0, 2),
            },
            areaPath: {
                description: "Area path for categorization",
                usedValues: usedValues.areas,
            },
            iterationPath: {
                description: "Sprint/Iteration",
                usedValues: usedValues.iterations,
            },
            tags: {
                description: "Tags for filtering",
                usedValues: usedValues.tags,
                examples: usedValues.tags.slice(0, 3),
            },
            assignedTo: {
                description: "Assignee email",
                usedValues: usedValues.assignees,
            },
            parent: {
                description: "Parent work item ID",
                examples: usedValues.parents.slice(0, 2).map((p) => `${p.id} (${p.title})`),
            },
        },
        _source: {
            queryId,
            analyzedItemCount: items.length,
            generatedAt: new Date().toISOString(),
        },
    };
}

/**
 * Save a template to the created templates directory
 * Returns the file path
 */
export function saveTemplate(template: WorkItemTemplate, baseDir?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${timestamp}-New${template.type.replace(/\s+/g, "")}.json`;

    const dir = baseDir || join(process.cwd(), ".claude/azure/tasks/created");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(template, null, 2));

    return filePath;
}
