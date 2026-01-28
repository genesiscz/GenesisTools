#!/usr/bin/env bun
/**
 * Azure DevOps Work Item CLI Tool
 *
 * Usage:
 *   tools azure-devops --configure <any-azure-devops-url>
 *   tools azure-devops --query <url|id> [--format ai|md|json]
 *   tools azure-devops --workitem <url|id> [--format ai|md|json]
 *   tools azure-devops --dashboard <url|id> [--format ai|md|json]
 *   tools azure-devops --list
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { input, select, confirm, editor } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";

// Types
import type {
  AzureConfig,
  OutputFormat,
  WorkItem,
  WorkItemFull,
  WorkItemCache,
  QueryCache,
  QueriesCache,
  ChangeInfo,
  QueryFilters,
  WorkItemSettings,
  WorkItemType,
  JsonPatchOperation,
  WorkItemTemplate,
} from "./types";

// Utils
import {
  htmlToMarkdown,
  getRelativeTime,
  getLocalConfigDir,
  getTasksDir,
  requireConfig,
  findTaskFile,
  findTaskFileAnywhere,
  getTaskFilePath,
  extractQueryId,
  isQueryIdOrUrl,
  findQueryByName,
  extractWorkItemIds,
  extractDashboardId,
  parseAzureDevOpsUrl,
  parseRelations,
  detectChanges,
  buildFieldSchema,
  generateTemplateFromQuery,
  generateTemplateFromWorkItem,
  saveTemplate,
  extractUsedValues,
  mergeFieldsWithUsage,
} from "./utils";

// API
import { Api, AZURE_DEVOPS_RESOURCE_ID } from "./api";

// CLI Utils
import { exitWithAuthGuide, exitWithSslGuide, isAuthError, isSslError } from "./cli.utils";

// Cache TTL
const CACHE_TTL = "180 days";
const WORKITEM_CACHE_TTL_MINUTES = 5;
const PROJECT_CACHE_TTL = "30 days";
const QUERIES_CACHE_TTL = "30 days";

// Storage for global cache
const storage = new Storage("azure-devops");

// ============= Cache Management (using Storage utility) =============

async function loadGlobalCache<T>(type: "query" | "workitem" | "dashboard", id: string): Promise<T | null> {
  await storage.ensureDirs();
  return storage.getCacheFile<T>(`${type}-${id}.json`, CACHE_TTL);
}

async function saveGlobalCache<T>(type: "query" | "workitem" | "dashboard", id: string, data: T): Promise<void> {
  await storage.ensureDirs();
  await storage.putCacheFile(`${type}-${id}.json`, data, CACHE_TTL);
}

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
  lines.push("| ID | Title | State | Severity | Assignee |");
  lines.push("|-----|-------|-------|----------|----------|");
  for (const item of items) {
    const title = item.title.length > 40 ? item.title.slice(0, 37) + "..." : item.title;
    lines.push(`| ${item.id} | ${title} | ${item.state} | ${item.severity || "-"} | ${item.assignee || "-"} |`);
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

function formatWorkItemAI(item: WorkItemFull, taskPath: string, cacheTime?: Date): string {
  const lines: string[] = [];

  lines.push(`# Work Item #${item.id}`);
  lines.push("");
  lines.push(`**${item.title}**`);
  lines.push("");
  if (cacheTime) {
    lines.push(`📦 From cache (${getRelativeTime(cacheTime)}) - use --force to refresh`);
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
      lines.push(`- **Children**: ${parsed.children.map(id => `#${id}`).join(", ")}`);
    }
    if (parsed.related.length > 0) {
      lines.push(`- **Related**: ${parsed.related.map(id => `#${id}`).join(", ")}`);
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
  lines.push(`| Created | ${item.created ? new Date(item.created).toLocaleString() : "N/A"} by ${item.createdBy || "Unknown"} |`);
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
      lines.push(`- **Children**: ${parsed.children.map(id => `#${id}`).join(", ")}`);
    }
    if (parsed.related.length > 0) {
      lines.push(`- **Related**: ${parsed.related.map(id => `#${id}`).join(", ")}`);
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

function formatMD(items: WorkItem[]): string {
  const lines: string[] = [];
  lines.push("| ID | Title | State | Severity | Assignee |");
  lines.push("|---|---|---|---|---|");
  for (const item of items) {
    lines.push(`| ${item.id} | ${item.title.slice(0, 50)} | ${item.state} | ${item.severity || "-"} | ${item.assignee || "-"} |`);
  }
  return lines.join("\n");
}

function formatJSON<T>(data: T): string {
  return JSON.stringify(data, null, 2);
}

// ============= Handlers =============

async function handleConfigure(url: string): Promise<void> {
  console.log("🔧 Configuring Azure DevOps CLI...\n");

  // Check if logged in
  try {
    await $`az account show`.quiet();
  } catch {
    exitWithAuthGuide();
  }

  console.log(`Parsing URL: ${url}\n`);

  const { org, project } = parseAzureDevOpsUrl(url);

  console.log(`  Organization: ${org}`);
  console.log(`  Project: ${project}`);

  console.log("\nFetching project ID from API...");

  const projectId = await Api.getProjectId(org, project);
  console.log(`  Project ID: ${projectId}`);

  const newConfig: AzureConfig = {
    org,
    project,
    projectId,
    apiResource: AZURE_DEVOPS_RESOURCE_ID,
  };

  // Save to local config directory (cwd)
  const configDir = getLocalConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

  console.log(`\n✅ Configuration saved to: ${configPath}`);
  console.log("\nConfig values:");
  console.log("```json");
  console.log(JSON.stringify(newConfig, null, 2));
  console.log("```");

  // Configure az devops defaults
  console.log("\nConfiguring az devops defaults...");
  try {
    await $`az devops configure --defaults organization=${org} project=${project}`.quiet();
    console.log("✅ az devops defaults configured");
  } catch {
    console.log("⚠️  Could not configure az devops defaults");
  }

  console.log(`
🎉 Done! You can now use the tool:

  tools azure-devops --query <id>
  tools azure-devops --workitem <id>
  tools azure-devops --dashboard <id>
`);
}

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
  console.log(`🔍 Searching for query: "${input}"`);

  // Load queries cache
  await storage.ensureDirs();
  let queriesCache = await storage.getCacheFile<QueriesCache>("queries-list.json", QUERIES_CACHE_TTL);

  // Refresh cache if needed
  if (!queriesCache || queriesCache.project !== config.project) {
    console.log("📥 Fetching queries list from Azure DevOps...");
    const queries = await api.getAllQueries();
    queriesCache = {
      project: config.project,
      queries,
      fetchedAt: new Date().toISOString(),
    };
    await storage.putCacheFile("queries-list.json", queriesCache, QUERIES_CACHE_TTL);
    console.log(`✅ Cached ${queries.length} queries`);
  }

  // Find the best match
  const result = findQueryByName(input, queriesCache.queries);

  if (!result) {
    throw new Error(`No query found matching "${input}". Use --query with a GUID or URL instead.`);
  }

  // If exact match (score = 1.0), use it directly
  if (result.score >= 0.95) {
    console.log(`✅ Found query: "${result.query.name}" (${result.query.path})`);
    return result.query.id;
  }

  // If good match but not exact, show what we found
  console.log(`✅ Best match: "${result.query.name}" (${result.query.path}) [${Math.round(result.score * 100)}% match]`);

  if (result.alternatives.length > 0) {
    console.log(`   Other matches:`);
    for (const alt of result.alternatives) {
      console.log(`   - "${alt.name}" (${alt.path})`);
    }
  }

  return result.query.id;
}

async function handleQuery(input: string, format: OutputFormat, forceRefresh: boolean, filters?: QueryFilters, downloadWorkitems?: boolean, category?: string, taskFolders?: boolean): Promise<void> {
  const config = requireConfig();
  const api = new Api(config);
  const queryId = await resolveQueryId(input, api, config);

  // Load old cache
  const rawCache = forceRefresh ? null : await loadGlobalCache<QueryCache>("query", queryId);
  const oldCache = rawCache?.items || null;
  const oldCacheTime = rawCache?.fetchedAt ? new Date(rawCache.fetchedAt) : undefined;

  // Run query
  let items = await api.runQuery(queryId);

  // Apply filters
  if (filters?.states && filters.states.length > 0) {
    const normalizedStates = filters.states.map(s => s.toLowerCase());
    items = items.filter(item => normalizedStates.includes(item.state.toLowerCase()));
  }
  if (filters?.severities && filters.severities.length > 0) {
    const normalizedSeverities = filters.severities.map(s => s.toLowerCase());
    items = items.filter(item => item.severity && normalizedSeverities.includes(item.severity.toLowerCase()));
  }

  // Detect changes
  const changes = oldCache ? detectChanges(oldCache, items) : items.map(item => ({
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

  // Save to global cache (including query-level category/taskFolders if provided)
  const cacheData: QueryCache = {
    items: items.map(item => ({
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
    // Use cached query settings as defaults if not explicitly provided
    const effectiveCategory = cacheData.category;
    const effectiveTaskFolders = cacheData.taskFolders ?? false;

    console.log(`\n📥 Downloading ${items.length} work items${effectiveCategory ? ` to category: ${effectiveCategory}` : ""}${effectiveTaskFolders ? " (with task folders)" : ""}...\n`);
    const ids = items.map(item => item.id).join(",");
    await handleWorkItem(ids, format, forceRefresh, effectiveCategory, effectiveTaskFolders);
  }
}

async function handleWorkItem(input: string, format: OutputFormat, forceRefresh: boolean, categoryArg?: string, taskFoldersArg?: boolean): Promise<void> {
  const config = requireConfig();
  const api = new Api(config);
  const ids = extractWorkItemIds(input);
  const results: WorkItemFull[] = [];
  const cacheTimes: Map<number, Date> = new Map();
  const settingsMap: Map<number, WorkItemSettings> = new Map();

  for (const id of ids) {
    // Check cache for 5-minute TTL and settings
    const cache = await loadGlobalCache<WorkItemCache>("workitem", String(id));

    // First, check if file already exists anywhere
    const existingFile = findTaskFileAnywhere(id, "json");

    // Determine settings: existing file location > args > cache > defaults
    let finalCategory: string | undefined;
    let finalTaskFolder: boolean;

    if (existingFile) {
      // File exists - keep it where it is (respect existing location)
      finalCategory = existingFile.category;
      finalTaskFolder = existingFile.inTaskFolder;
    } else {
      // New file - use args > cache > defaults
      finalCategory = categoryArg ?? cache?.category;
      finalTaskFolder = taskFoldersArg ?? cache?.taskFolder ?? false;
    }

    settingsMap.set(id, { category: finalCategory, taskFolder: finalTaskFolder });

    // Ensure tasks directory exists
    const tasksDir = finalTaskFolder
      ? join(getTasksDir(finalCategory), String(id))
      : getTasksDir(finalCategory);
    if (!existsSync(tasksDir)) {
      mkdirSync(tasksDir, { recursive: true });
    }

    const existingJsonPath = existingFile?.path || null;

    if (!forceRefresh && cache && existingJsonPath && existsSync(existingJsonPath)) {
      const cacheDate = new Date(cache.fetchedAt);
      const ageMinutes = (Date.now() - cacheDate.getTime()) / 60000;
      if (ageMinutes < WORKITEM_CACHE_TTL_MINUTES) {
        const cachedItem = JSON.parse(readFileSync(existingJsonPath, "utf-8")) as WorkItemFull;
        results.push(cachedItem);
        cacheTimes.set(id, cacheDate);
        continue;
      }
    }

    // Fetch fresh data
    const item = await api.getWorkItem(id);
    results.push(item);

    // Generate new slugified paths
    const jsonPath = getTaskFilePath(id, item.title, "json", finalCategory, finalTaskFolder);
    const mdPath = getTaskFilePath(id, item.title, "md", finalCategory, finalTaskFolder);

    // Ensure target directory exists (in case of task folder)
    const targetDir = dirname(jsonPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Clean up old files if path changed (different slug, category, or folder setting)
    if (existingJsonPath && existingJsonPath !== jsonPath) {
      try {
        const existingMdPath = existingJsonPath.replace(".json", ".md");
        if (existsSync(existingJsonPath)) unlinkSync(existingJsonPath);
        if (existsSync(existingMdPath)) unlinkSync(existingMdPath);
        // Try to remove empty parent directory
        const oldDir = dirname(existingJsonPath);
        if (existsSync(oldDir) && readdirSync(oldDir).length === 0) {
          rmdirSync(oldDir);
        }
      } catch { /* ignore */ }
    }

    // Save to tasks (local in cwd)
    writeFileSync(jsonPath, JSON.stringify(item, null, 2));
    writeFileSync(mdPath, generateWorkItemMarkdown(item));

    // Update global cache with settings
    const cacheData: WorkItemCache = {
      id: item.id,
      rev: item.rev,
      changed: item.changed,
      title: item.title,
      state: item.state,
      commentCount: item.comments.length,
      fetchedAt: new Date().toISOString(),
      category: finalCategory,
      taskFolder: finalTaskFolder,
    };
    await saveGlobalCache("workitem", String(id), cacheData);
  }

  // Output
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const settings = settingsMap.get(item.id);
    const taskPath = findTaskFile(item.id, "json", settings?.category) || getTaskFilePath(item.id, item.title, "json", settings?.category, settings?.taskFolder);
    const cacheTime = cacheTimes.get(item.id);

    if (i > 0) console.log("\n---\n");

    switch (format) {
      case "ai":
        console.log(formatWorkItemAI(item, taskPath, cacheTime));
        break;
      case "md":
        console.log(`# ${item.title}\n\n${item.description || "No description"}\n\n## Comments\n${item.comments.map(c => `- **${c.author}**: ${c.text}`).join("\n")}`);
        break;
      case "json":
        console.log(formatJSON(item));
        break;
    }
  }
}

async function handleDashboard(input: string, format: OutputFormat): Promise<void> {
  const config = requireConfig();
  const api = new Api(config);
  const dashboardId = extractDashboardId(input);

  const dashboard = await api.getDashboard(dashboardId);

  // Save to global cache
  await saveGlobalCache("dashboard", dashboardId, dashboard);

  const lines: string[] = [];
  lines.push(`# Dashboard: ${dashboard.name}`);
  lines.push("");
  lines.push(`Found ${dashboard.queries.length} queries:`);
  lines.push("");

  for (const q of dashboard.queries) {
    lines.push(`- **${q.name}**: \`${q.queryId}\``);
  }

  lines.push("");
  lines.push("To fetch a query, run:");
  for (const q of dashboard.queries) {
    lines.push(`  tools azure-devops --query ${q.queryId}`);
  }

  switch (format) {
    case "ai":
    case "md":
      console.log(lines.join("\n"));
      break;
    case "json":
      console.log(formatJSON(dashboard));
      break;
  }
}

async function handleList(): Promise<void> {
  const lines: string[] = [];
  lines.push("# Cached Work Items");
  lines.push("");

  const cacheFiles = await storage.listCacheFiles(false);
  const workitemFiles = cacheFiles.filter(f => f.startsWith("workitem-") && f.endsWith(".json"));

  if (workitemFiles.length === 0) {
    lines.push("No cached work items found.");
    console.log(lines.join("\n"));
    return;
  }

  const items: Array<{ id: number; title: string; state: string; fetchedAt: Date; hasTask: boolean }> = [];

  for (const file of workitemFiles) {
    try {
      const cache = await storage.getCacheFile<WorkItemCache>(file, CACHE_TTL);
      if (cache) {
        const taskFile = findTaskFile(cache.id, "json");
        items.push({
          id: cache.id,
          title: cache.title,
          state: cache.state,
          fetchedAt: new Date(cache.fetchedAt),
          hasTask: taskFile !== null,
        });
      }
    } catch { /* ignore */ }
  }

  items.sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());

  lines.push(`Found ${items.length} cached work items:`);
  lines.push("");
  lines.push("| ID | Title | State | Cached | Has File |");
  lines.push("|-----|-------|-------|--------|----------|");

  for (const item of items) {
    const title = item.title.length > 35 ? item.title.slice(0, 32) + "..." : item.title;
    const age = getRelativeTime(item.fetchedAt);
    lines.push(`| ${item.id} | ${title} | ${item.state} | ${age} | ${item.hasTask ? "✓" : "✗"} |`);
  }

  lines.push("");
  lines.push("To refresh a work item:");
  lines.push("  tools azure-devops --workitem <id> --force");

  console.log(lines.join("\n"));
}

// ============= Interactive Create Mode =============

// Common work item types to show first (others available via "Show all...")
const COMMON_WORK_ITEM_TYPES = ["Bug", "Task", "User Story", "Feature", "Epic", "Incident"];

/** Wizard state for interactive create */
interface WizardState {
  project?: { id: string; name: string };
  type?: WorkItemType;
  typeDef?: Awaited<ReturnType<Api["getWorkItemTypeDefinition"]>>;
  fieldSchema?: Map<string, { name: string; required: boolean; allowedValues?: string[]; helpText?: string; defaultValue?: string }>;
  title?: string;
  description?: string;
  additionalFields?: Map<string, string>;
  state?: string;
  tags?: string[];
  assignee?: string;
  parentId?: number;
}

/** Projects cache structure */
interface ProjectsCache {
  org: string;
  projects: Array<{ id: string; name: string }>;
  fetchedAt: string;
}

/** Load cached projects list */
async function loadProjectsCache(org: string): Promise<Array<{ id: string; name: string }> | null> {
  const cache = await storage.getCacheFile<ProjectsCache>("projects.json", PROJECT_CACHE_TTL);
  if (cache && cache.org === org) {
    return cache.projects;
  }
  return null;
}

/** Save projects to cache */
async function saveProjectsCache(org: string, projects: Array<{ id: string; name: string }>): Promise<void> {
  const cache: ProjectsCache = {
    org,
    projects,
    fetchedAt: new Date().toISOString(),
  };
  await storage.putCacheFile("projects.json", cache, PROJECT_CACHE_TTL);
}

/**
 * Run interactive work item creation flow with ESC-based back navigation
 */
async function runInteractiveCreate(api: Api, config: AzureConfig): Promise<void> {
  console.log("\n🆕 Create New Work Item\n");
  console.log(`🏢 Organization: ${config.org}`);
  console.log(`📁 Default project: ${config.project}\n`);
  console.log("💡 Press Ctrl+C to cancel, ESC to go back\n");

  const state: WizardState = {};
  let currentStep = 0;
  let activeApi = api;
  let activeConfig = config;

  // Wizard steps as functions that return their value
  const steps: Array<{
    name: string;
    run: () => Promise<boolean>; // Returns true if step completed, false if cancelled/back
  }> = [
    // Step 0: Project selection
    {
      name: "project",
      run: async () => {
        // Load or fetch projects
        let projects = await loadProjectsCache(config.org);
        if (!projects) {
          console.log("📥 Fetching projects...");
          const fetchedProjects = await Api.getProjects(config.org);
          await saveProjectsCache(config.org, fetchedProjects);
          projects = fetchedProjects;
        }

        // Find configured project and put it first
        const configuredProject = projects.find(p => p.name === config.project);
        const otherProjects = projects.filter(p => p.name !== config.project);
        const sortedProjects = configuredProject
          ? [configuredProject, ...otherProjects]
          : projects;

        const choices = sortedProjects.map(p => ({
          value: p,
          name: p.name === config.project ? `${p.name} (configured)` : p.name,
        }));

        const selected = await select({
          message: "Select project:",
          choices,
        });

        state.project = selected;

        // If different project selected, create new API instance
        if (selected.name !== config.project) {
          activeConfig = { ...config, project: selected.name, projectId: selected.id };
          activeApi = new Api(activeConfig);
          console.log(`\n📁 Switched to project: ${selected.name}\n`);
        }

        return true;
      },
    },
    // Step 1: Work item type
    {
      name: "type",
      run: async () => {
        const allTypes = await activeApi.getAvailableWorkItemTypes();
        const commonTypes = allTypes.filter((t: string) => COMMON_WORK_ITEM_TYPES.includes(t));
        const otherTypes = allTypes.filter((t: string) => !COMMON_WORK_ITEM_TYPES.includes(t));

        const typeChoices: Array<{ value: string; name: string }> = [
          ...commonTypes.map((t: string) => ({ value: t, name: t })),
        ];

        if (otherTypes.length > 0) {
          typeChoices.push({ value: "__show_all__", name: `Show all types (${otherTypes.length} more)...` });
        }

        const selectedType = await select({
          message: "Select work item type:",
          choices: typeChoices,
        });

        let type: WorkItemType;
        if (selectedType === "__show_all__") {
          const allTypeSelection = await select({
            message: "Select work item type (all available):",
            choices: allTypes.sort().map((t: string) => ({ value: t, name: t })),
          });
          type = allTypeSelection as WorkItemType;
        } else {
          type = selectedType as WorkItemType;
        }

        state.type = type;

        // Get type definition
        const typeDef = await activeApi.getWorkItemTypeDefinition(type);
        state.typeDef = typeDef;
        state.fieldSchema = buildFieldSchema(typeDef);

        return true;
      },
    },
    // Step 2: Title
    {
      name: "title",
      run: async () => {
        const title = await input({
          message: "Title (required):",
          default: state.title || "",
          validate: (value) => value.trim().length > 0 || "Title is required",
        });
        state.title = title;
        return true;
      },
    },
    // Step 3: Description
    {
      name: "description",
      run: async () => {
        const descriptionField = state.fieldSchema?.get("System.Description");
        const descriptionTemplate = descriptionField?.helpText || "";
        const isRequired = descriptionField?.required || false;

        const useDescription = await confirm({
          message: isRequired ? "Add description? (required)" : "Add description?",
          default: isRequired || !!state.description,
        });

        if (useDescription || isRequired) {
          state.description = await editor({
            message: isRequired ? "Description (required, opens editor):" : "Description (opens editor):",
            default: state.description || descriptionTemplate,
            validate: isRequired ? ((value) => value.trim() ? true : "Description is required") : undefined,
          });
        } else {
          state.description = "";
        }
        return true;
      },
    },
    // Step 4: Required fields
    {
      name: "requiredFields",
      run: async () => {
        if (!state.fieldSchema || !state.type) return true;

        const handledFields = new Set(["System.Title", "System.Description", "System.State", "System.Tags", "System.AssignedTo"]);
        const additionalFields: Map<string, string> = state.additionalFields || new Map();

        const requiredFields: Array<{ refName: string; name: string; allowedValues?: string[]; helpText?: string }> = [];
        for (const [refName, fieldInfo] of state.fieldSchema) {
          if (fieldInfo.required && !handledFields.has(refName)) {
            requiredFields.push({
              refName,
              name: fieldInfo.name,
              allowedValues: fieldInfo.allowedValues,
              helpText: fieldInfo.helpText,
            });
          }
        }

        if (requiredFields.length > 0) {
          console.log(`\n📋 Required fields for ${state.type}:\n`);
          for (const field of requiredFields) {
            let value: string;
            const existingValue = additionalFields.get(field.refName);

            if (field.allowedValues && field.allowedValues.length > 0) {
              value = await select({
                message: `${field.name} (required):`,
                choices: field.allowedValues.map((v: string) => ({ value: v, name: v })),
                default: existingValue,
              });
            } else {
              value = await input({
                message: `${field.name} (required):`,
                default: existingValue || "",
                validate: (v) => v.trim().length > 0 || `${field.name} is required`,
              });
            }
            additionalFields.set(field.refName, value);
          }
        }

        state.additionalFields = additionalFields;
        return true;
      },
    },
    // Step 5: State
    {
      name: "state",
      run: async () => {
        const stateField = state.fieldSchema?.get("System.State");
        const stateValue = await select({
          message: "Initial state:",
          choices: stateField?.allowedValues?.map((v: string) => ({ value: v, name: v })) || [
            { value: "New", name: "New" },
          ],
          default: state.state || stateField?.defaultValue || "New",
        });
        state.state = stateValue;
        return true;
      },
    },
    // Step 6: Tags
    {
      name: "tags",
      run: async () => {
        const addTags = await confirm({
          message: "Add tags?",
          default: (state.tags?.length || 0) > 0,
        });

        if (addTags) {
          const tagInput = await input({
            message: "Tags (comma-separated):",
            default: state.tags?.join(", ") || "",
          });
          state.tags = tagInput.split(",").map(t => t.trim()).filter(Boolean);
        } else {
          state.tags = [];
        }
        return true;
      },
    },
    // Step 7: Assignee
    {
      name: "assignee",
      run: async () => {
        state.assignee = await input({
          message: "Assignee email (or press Enter to skip):",
          default: state.assignee || "",
        });
        return true;
      },
    },
    // Step 8: Parent
    {
      name: "parent",
      run: async () => {
        const addParent = await confirm({
          message: "Link to parent work item?",
          default: state.parentId !== undefined,
        });

        if (addParent) {
          const parentInput = await input({
            message: "Parent work item ID:",
            default: state.parentId?.toString() || "",
            validate: (value) => {
              if (!value) return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num > 0 || "Enter a valid work item ID";
            },
          });
          if (parentInput) {
            state.parentId = parseInt(parentInput, 10);
          }
        } else {
          state.parentId = undefined;
        }
        return true;
      },
    },
    // Step 9: Confirm and create
    {
      name: "confirm",
      run: async () => {
        console.log("\n📋 Summary:");
        console.log(`  Project: ${state.project?.name || activeConfig.project}`);
        console.log(`  Type: ${state.type}`);
        console.log(`  Title: ${state.title}`);
        console.log(`  State: ${state.state}`);
        if (state.additionalFields) {
          for (const [refName, value] of state.additionalFields) {
            const fieldInfo = state.fieldSchema?.get(refName);
            console.log(`  ${fieldInfo?.name || refName}: ${value}`);
          }
        }
        if (state.tags && state.tags.length > 0) console.log(`  Tags: ${state.tags.join(", ")}`);
        if (state.assignee) console.log(`  Assignee: ${state.assignee}`);
        if (state.parentId) console.log(`  Parent: #${state.parentId}`);
        console.log("");

        const confirmed = await confirm({
          message: "Create this work item?",
          default: true,
        });

        if (!confirmed) {
          // Go back to allow editing
          return false;
        }

        // Build JSON Patch operations
        const operations: JsonPatchOperation[] = [
          { op: "add", path: "/fields/System.Title", value: state.title! },
        ];

        if (state.description) {
          operations.push({ op: "add", path: "/fields/System.Description", value: state.description });
        }

        if (state.state && state.state !== "New") {
          operations.push({ op: "add", path: "/fields/System.State", value: state.state });
        }

        if (state.additionalFields) {
          for (const [refName, value] of state.additionalFields) {
            operations.push({ op: "add", path: `/fields/${refName}`, value });
          }
        }

        if (state.tags && state.tags.length > 0) {
          operations.push({ op: "add", path: "/fields/System.Tags", value: state.tags.join("; ") });
        }

        if (state.assignee) {
          operations.push({ op: "add", path: "/fields/System.AssignedTo", value: state.assignee });
        }

        // Add parent relation if specified
        if (state.parentId) {
          operations.push({
            op: "add",
            path: "/relations/-",
            value: {
              rel: "System.LinkTypes.Hierarchy-Reverse",
              url: `${activeConfig.org}/_apis/wit/workItems/${state.parentId}`,
              attributes: { comment: "Created via CLI" },
            },
          });
        }

        console.log("\n⏳ Creating work item...");
        const created = await activeApi.createWorkItem(state.type!, operations);

        console.log(`\n✅ Created work item #${created.id}: ${created.title}`);
        console.log(`   URL: ${created.url}`);
        return true;
      },
    },
  ];

  // Run wizard with back navigation
  try {
    while (currentStep < steps.length) {
      try {
        const step = steps[currentStep];
        const result = await step.run();

        if (result) {
          currentStep++;
        } else if (currentStep > 0) {
          // Go back if not confirmed
          currentStep--;
        }
      } catch (error) {
        if (error instanceof ExitPromptError) {
          // User cancelled (Ctrl+C or closed prompt)
          if (currentStep > 0) {
            console.log("\n⬅️  Going back...\n");
            currentStep--;
          } else {
            console.log("\n❌ Creation cancelled.");
            return;
          }
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof ExitPromptError) {
      console.log("\n❌ Creation cancelled.");
      return;
    }
    throw error;
  }
}

// ============= From-File Creation =============

/**
 * Convert a WorkItemTemplate to JSON Patch operations for the API
 */
function templateToOperations(template: WorkItemTemplate): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  const fields = template.fields as Record<string, unknown>;

  // Map simple field names to Azure DevOps field reference names
  const fieldMapping: Record<string, string> = {
    title: "System.Title",
    description: "System.Description",
    severity: "Microsoft.VSTS.Common.Severity",
    areaPath: "System.AreaPath",
    iterationPath: "System.IterationPath",
    assignedTo: "System.AssignedTo",
    state: "System.State",
    priority: "Microsoft.VSTS.Common.Priority",
    activity: "Microsoft.VSTS.Common.Activity",
    effort: "Microsoft.VSTS.Scheduling.Effort",
    remainingWork: "Microsoft.VSTS.Scheduling.RemainingWork",
    originalEstimate: "Microsoft.VSTS.Scheduling.OriginalEstimate",
    valueArea: "Microsoft.VSTS.Common.ValueArea",
    risk: "Microsoft.VSTS.Common.Risk",
    businessValue: "Microsoft.VSTS.Common.BusinessValue",
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;

    // Handle tags array specially
    if (key === "tags") {
      const tagValue = Array.isArray(value) ? value.join("; ") : value;
      if (tagValue) {
        operations.push({
          op: "add",
          path: "/fields/System.Tags",
          value: tagValue,
        });
      }
      continue;
    }

    // Map simple field name to reference name
    let refName = fieldMapping[key];

    if (!refName) {
      // Check if key already looks like a reference name (contains '.')
      if (key.includes(".")) {
        refName = key;
      } else {
        // Try to infer reference name for custom fields
        // Common patterns: "application" -> "Custom.Application"
        // Check template hints for the original reference name
        const hint = template._hints?.[key];
        if (hint?.description?.includes("(") && hint?.description?.includes(")")) {
          // Extract reference name from description like "Pre-filled from source work item (Custom.Application)"
          const match = hint.description.match(/\(([^)]+)\)/);
          if (match && match[1].includes(".")) {
            refName = match[1];
          }
        }
        // If still no refName, skip unknown fields (don't guess)
        if (!refName) {
          continue;
        }
      }
    }

    operations.push({
      op: "add",
      path: `/fields/${refName}`,
      value,
    });
  }

  return operations;
}

/**
 * Validate a WorkItemTemplate before creation
 */
function validateTemplate(template: WorkItemTemplate): void {
  if (!template.$schema || template.$schema !== "azure-devops-workitem-v1") {
    throw new Error("Invalid template: missing or incorrect $schema");
  }

  if (!template.type) {
    throw new Error("Invalid template: missing work item type");
  }

  if (!template.fields) {
    throw new Error("Invalid template: missing fields");
  }

  const title = (template.fields as Record<string, unknown>).title;
  if (!title || (typeof title === "string" && !title.trim())) {
    throw new Error("Invalid template: title is required");
  }
}

/**
 * Create a work item from a template file
 */
async function createFromFile(api: Api, config: AzureConfig, filePath: string): Promise<void> {
  console.log(`\n📄 Loading template from: ${filePath}\n`);

  if (!existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  let template: WorkItemTemplate;

  try {
    template = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in template file: ${filePath}`);
  }

  // Validate template
  validateTemplate(template);

  const fields = template.fields as Record<string, unknown>;

  console.log("📋 Template contents:");
  console.log(`  Type: ${template.type}`);
  console.log(`  Title: ${fields.title}`);
  if (fields.severity) console.log(`  Severity: ${fields.severity}`);
  if (fields.assignedTo) console.log(`  Assignee: ${fields.assignedTo}`);
  if (fields.tags) {
    const tags = Array.isArray(fields.tags) ? fields.tags : [fields.tags];
    if (tags.length > 0) console.log(`  Tags: ${tags.join(", ")}`);
  }
  if (template.relations?.parent) console.log(`  Parent: #${template.relations.parent}`);
  console.log("");

  // Convert template to operations
  const operations = templateToOperations(template);

  // Add parent relation if specified
  if (template.relations?.parent) {
    operations.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: `${config.org}/_apis/wit/workItems/${template.relations.parent}`,
        attributes: { comment: "Created via CLI" },
      },
    });
  }

  // Create the work item
  console.log("⏳ Creating work item...");
  const created = await api.createWorkItem(template.type, operations);

  console.log(`\n✅ Created work item #${created.id}: ${created.title}`);
  console.log(`   URL: ${created.url}`);
}

// ============= Helper Functions =============

/** Infer work item type from raw fields */
function inferWorkItemTypeFromRawFields(item: WorkItemFull): WorkItemType | undefined {
  const rawType = item.rawFields?.["System.WorkItemType"];
  if (typeof rawType === "string") {
    return rawType as WorkItemType;
  }
  return undefined;
}

// ============= Create Handler =============

/**
 * Handle the --create command with various modes
 */
async function handleCreate(options: {
  interactive?: boolean;
  fromFile?: string;
  type?: string;
  sourceInput?: string;  // Query URL or work item URL
  title?: string;
  severity?: string;
  tags?: string;
  assignee?: string;
  parent?: string;
}): Promise<void> {
  // Check if any actual mode is specified - show help before requiring config
  const hasValidMode = options.interactive ||
    options.fromFile ||
    options.sourceInput ||
    (options.type && options.title);

  if (!hasValidMode) {
    // No valid mode specified - show help without requiring config
    console.log(`
Usage: tools azure-devops --create [options]

Modes:
  -i, --interactive             Interactive mode with prompts
  --from-file <path>            Create from template file
  <query-url> --type <type>     Generate template from query
  <workitem-url>                Generate template from work item
  --type <type> --title <text>  Quick non-interactive creation

Examples:
  tools azure-devops --create -i
  tools azure-devops --create --from-file template.json
  tools azure-devops --create "https://.../_queries/query/abc" --type Bug
  tools azure-devops --create "https://.../_workitems/edit/123"
  tools azure-devops --create --type Task --title "Fix bug"
`);
    return;
  }

  const config = requireConfig();
  const api = new Api(config);

  // Mode 1: Interactive mode (-i or --interactive)
  if (options.interactive) {
    await runInteractiveCreate(api, config);
    return;
  }

  // Mode 2: Create from template file (--from-file)
  if (options.fromFile) {
    await createFromFile(api, config, options.fromFile);
    return;
  }

  // Mode 3: Generate template from query URL
  // Match /_queries/query/ path or a bare GUID (query ID)
  if (options.sourceInput && (options.sourceInput.includes("/_queries/") || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sourceInput))) {
    const queryId = extractQueryId(options.sourceInput);
    const type = (options.type || "Bug") as WorkItemType;

    console.log(`\n📊 Generating template from query: ${queryId}`);
    console.log(`   Work item type: ${type}\n`);

    // Run query to get items
    const items = await api.runQuery(queryId);
    console.log(`   Found ${items.length} work items to analyze`);

    // Get type definition for field hints
    const typeDef = await api.getWorkItemTypeDefinition(type);
    const fieldSchema = buildFieldSchema(typeDef);
    const hints = mergeFieldsWithUsage(fieldSchema, extractUsedValues(items, config.project, queryId));

    // Generate template
    const template = generateTemplateFromQuery(items, type, config.project, queryId, hints);

    // Save template
    const filePath = saveTemplate(template);

    console.log(`\n✅ Template generated: ${filePath}`);
    console.log(`\n📝 Hints from ${items.length} analyzed items:`);

    // Show field hints
    if (template._hints) {
      const hintFields = ["severity", "tags", "assignedTo"];
      for (const field of hintFields) {
        const hint = template._hints[field];
        if (hint?.usedValues?.length) {
          console.log(`   ${field}: ${hint.usedValues.slice(0, 5).join(", ")}`);
        }
      }
    }

    console.log(`\n💡 Fill the template and run:`);
    console.log(`   tools azure-devops --create --from-file "${filePath}"`);
    return;
  }

  // Mode 4: Generate template from work item URL
  if (options.sourceInput && options.sourceInput.match(/workitems?|edit\/\d+/i)) {
    const ids = extractWorkItemIds(options.sourceInput);
    if (ids.length !== 1) {
      throw new Error("Please specify exactly one work item URL for template generation");
    }

    const id = ids[0];
    console.log(`\n📋 Generating template from work item #${id}\n`);

    // Get the source work item
    const sourceItem = await api.getWorkItem(id);

    // Determine type and get type definition for allowedValues
    const type = (options.type as WorkItemType) || inferWorkItemTypeFromRawFields(sourceItem) || "Bug";
    console.log(`   Type: ${type}`);

    // Fetch type definition to get allowedValues for each field
    const typeDef = await api.getWorkItemTypeDefinition(type);
    const fieldSchema = buildFieldSchema(typeDef);

    // Generate template with field schema for allowedValues
    const template = generateTemplateFromWorkItem(sourceItem, type, fieldSchema);

    // Save template
    const filePath = saveTemplate(template);

    console.log(`✅ Template generated: ${filePath}`);
    console.log(`\n📝 Pre-filled from source work item #${id}:`);
    console.log(`   Type: ${template.type}`);
    if (template.fields.severity) console.log(`   Severity: ${template.fields.severity}`);
    if (template.relations?.parent) console.log(`   Parent: #${template.relations.parent}`);

    console.log(`\n💡 Fill the template and run:`);
    console.log(`   tools azure-devops --create --from-file "${filePath}"`);
    return;
  }

  // Mode 5: Quick non-interactive creation (--type + --title required)
  if (options.type && options.title) {
    const type = options.type as WorkItemType;

    console.log(`\n🆕 Quick create: ${type}\n`);

    const operations: JsonPatchOperation[] = [
      { op: "add", path: "/fields/System.Title", value: options.title },
    ];

    if (options.severity) {
      operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Severity", value: options.severity });
    }

    if (options.tags) {
      operations.push({ op: "add", path: "/fields/System.Tags", value: options.tags.replace(/,/g, "; ") });
    }

    if (options.assignee) {
      operations.push({ op: "add", path: "/fields/System.AssignedTo", value: options.assignee });
    }

    console.log("⏳ Creating work item...");
    const created = await api.createWorkItem(type, operations);

    console.log(`\n✅ Created work item #${created.id}: ${created.title}`);
    console.log(`   URL: ${created.url}`);
    return;
  }
}

// ============= CLI =============

function printHelp(): void {
  console.log(`
Azure DevOps Work Item Tool

Usage:
  tools azure-devops --configure <any-azure-devops-url>
  tools azure-devops --query <url|id> [options]
  tools azure-devops --workitem <id|url|ids> [options]
  tools azure-devops --dashboard <url|id> [options]
  tools azure-devops --list
  tools azure-devops --create [options]

Options:
  --format <ai|md|json>       Output format (default: ai)
  --force, --refresh          Force refresh, ignore cache
  --state <states>            Filter by state (comma-separated)
  --severity <sev>            Filter by severity (comma-separated)
  --download-workitems        With --query: download all work items to tasks/
  --category <name>           Save to tasks/<category>/ (remembered per work item)
  --task-folders              Save in tasks/<id>/ subfolder (only for new files)
  --help                      Show this help

Create Options:
  -i, --interactive           Interactive mode with prompts
  --from-file <path>          Create from template file
  --type <type>               Work item type (Bug, Task, User Story, etc.)
  --title <text>              Work item title (for quick creation)
  --severity <sev>            Severity level
  --tags <tags>               Tags (comma-separated)
  --assignee <email>          Assignee email

First-Time Setup:
  1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
  2. Install extension: az extension add --name azure-devops
  3. Login: az login --allow-no-subscriptions --use-device-code
  4. Configure: tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"

Examples:
  # Configure with any Azure DevOps URL
  tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
  tools azure-devops --configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."

  # Fetch query
  tools azure-devops --query d6e14134-9d22-4cbb-b897-b1514f888667

  # Fetch work items (supports comma-separated IDs)
  tools azure-devops --workitem 12345
  tools azure-devops --workitem 12345,12346,12347

  # Force refresh
  tools azure-devops --workitem 12345 --force

  # Filter by state/severity
  tools azure-devops --query abc123 --state Active,Development
  tools azure-devops --query abc123 --severity A,B

  # Download all work items from a query to tasks/
  tools azure-devops --query abc123 --download-workitems
  tools azure-devops --query abc123 --state Active --download-workitems --force

  # Organize work items into categories (remembered for future fetches)
  tools azure-devops --query abc123 --download-workitems --category react19
  tools azure-devops --workitem 12345 --category hotfixes

  # Use task folders (each task in its own subfolder, only for new files)
  tools azure-devops --workitem 12345 --task-folders
  tools azure-devops --query abc123 --download-workitems --category react19 --task-folders

Create Examples:
  # Interactive mode - guided step-by-step creation
  tools azure-devops --create -i

  # Generate template from query (analyzes patterns in existing items)
  tools azure-devops --create "https://dev.azure.com/.../query/abc" --type Bug

  # Generate template from existing work item
  tools azure-devops --create "https://dev.azure.com/.../_workitems/edit/12345"

  # Create from template file
  tools azure-devops --create --from-file ".claude/azure/tasks/created/template.json"

  # Quick non-interactive creation
  tools azure-devops --create --type Task --title "Fix login bug"
  tools azure-devops --create --type Bug --title "Error in checkout" --severity "A - critical"

Storage:
  Config:  .claude/azure/config.json (per-project, searched up to 3 levels)
  Cache:   ~/.genesis-tools/azure-devops/cache/ (global, 180 days)
  Tasks:   .claude/azure/tasks/ (per-project, in cwd)

Documentation: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const format: OutputFormat = (args.includes("--format")
    ? args[args.indexOf("--format") + 1] as OutputFormat
    : "ai") || "ai";

  const forceRefresh = args.includes("--refresh") || args.includes("--force") || args.includes("--no-cache");
  const downloadWorkitems = args.includes("--download-workitems");

  const category = args.includes("--category")
    ? args[args.indexOf("--category") + 1]
    : undefined;

  const taskFolders = args.includes("--task-folders");

  const filters: QueryFilters = {};
  if (args.includes("--state")) {
    const stateVal = args[args.indexOf("--state") + 1];
    if (stateVal) {
      filters.states = stateVal.split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  if (args.includes("--severity")) {
    const sevVal = args[args.indexOf("--severity") + 1];
    if (sevVal) {
      filters.severities = sevVal.split(",").map(s => s.trim()).filter(Boolean);
    }
  }

  try {
    // Handle --create
    if (args.includes("--create")) {
      const createOptions: {
        interactive?: boolean;
        fromFile?: string;
        type?: string;
        sourceInput?: string;
        title?: string;
        severity?: string;
        tags?: string;
        assignee?: string;
        parent?: string;
      } = {};

      createOptions.interactive = args.includes("-i") || args.includes("--interactive");

      if (args.includes("--from-file")) {
        createOptions.fromFile = args[args.indexOf("--from-file") + 1];
      }

      if (args.includes("--type")) {
        createOptions.type = args[args.indexOf("--type") + 1];
      }

      if (args.includes("--title")) {
        createOptions.title = args[args.indexOf("--title") + 1];
      }

      if (args.includes("--severity")) {
        createOptions.severity = args[args.indexOf("--severity") + 1];
      }

      if (args.includes("--tags")) {
        createOptions.tags = args[args.indexOf("--tags") + 1];
      }

      if (args.includes("--assignee")) {
        createOptions.assignee = args[args.indexOf("--assignee") + 1];
      }

      if (args.includes("--parent")) {
        createOptions.parent = args[args.indexOf("--parent") + 1];
      }

      // Check for source input (query or workitem URL that's not a flag value)
      const createIndex = args.indexOf("--create");
      const nextArg = args[createIndex + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        createOptions.sourceInput = nextArg;
      }

      await handleCreate(createOptions);
      return;  // Exit after handling create
    }

    if (args.includes("--configure")) {
      const input = args[args.indexOf("--configure") + 1];
      if (!input) throw new Error("Missing Azure DevOps URL");
      await handleConfigure(input);
    } else if (args.includes("--query")) {
      const input = args[args.indexOf("--query") + 1];
      if (!input) throw new Error("Missing query URL/ID");
      await handleQuery(input, format, forceRefresh, filters, downloadWorkitems, category, taskFolders);
    } else if (args.includes("--workitem")) {
      const input = args[args.indexOf("--workitem") + 1];
      if (!input) throw new Error("Missing work item URL/ID");
      await handleWorkItem(input, format, forceRefresh, category, taskFolders);
    } else if (args.includes("--dashboard")) {
      const input = args[args.indexOf("--dashboard") + 1];
      if (!input) throw new Error("Missing dashboard URL/ID");
      await handleDashboard(input, format);
    } else if (args.includes("--list")) {
      await handleList();
    } else {
      printHelp();
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isSslError(message)) {
      exitWithSslGuide(error);
    }

    if (isAuthError(message)) {
      exitWithAuthGuide(error);
    }

    logger.error(`Error: ${message}`);

    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }

    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(`Unexpected error: ${err}`);
  process.exit(1);
});
