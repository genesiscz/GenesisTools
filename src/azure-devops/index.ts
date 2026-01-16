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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "fs";
import { join, dirname } from "path";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";

// Azure DevOps API resource ID (constant for all Azure DevOps organizations)
const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

// Cache TTL
const CACHE_TTL = "180 days";
const WORKITEM_CACHE_TTL_MINUTES = 5;

// Storage for global cache
const storage = new Storage("azure-devops");

// ============= Configuration =============

interface AzureConfig {
  org: string;
  project: string;
  projectId: string;
  apiResource: string;
}

/**
 * Search for config file starting from cwd, up to 3 parent levels
 */
function findConfigPath(): string | null {
  const configName = ".claude/azure/config.json";
  let currentDir = process.cwd();

  for (let i = 0; i < 4; i++) { // current + 3 levels up
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
function getLocalConfigDir(): string {
  return join(process.cwd(), ".claude/azure");
}

/**
 * Get the tasks directory (always in cwd), optionally with category subdirectory
 */
function getTasksDir(category?: string): string {
  const base = join(process.cwd(), ".claude/azure/tasks");
  return category ? join(base, category) : base;
}

/**
 * Load config from file or return null if not found
 */
function loadConfig(): AzureConfig | null {
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
function requireConfig(): AzureConfig {
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

// ============= Utility Functions =============

function slugify(title: string): string {
  return title
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^a-zA-Z0-9]+/g, "-") // Replace non-alphanumeric with dash
    .replace(/^-+|-+$/g, "") // Trim dashes
    .slice(0, 50); // Limit length
}

function getRelativeTime(date: Date): string {
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

/**
 * Find task file in a specific directory (flat, not in task subfolder)
 */
function findTaskFileFlat(id: number, ext: string, dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  const match = files.find(f => f.startsWith(`${id}-`) && f.endsWith(`.${ext}`));
  return match ? join(dir, match) : null;
}

/**
 * Find task file in task subfolder (<dir>/<id>/<id>-...)
 */
function findTaskFileInFolder(id: number, ext: string, dir: string): string | null {
  const taskFolderPath = join(dir, String(id));
  if (!existsSync(taskFolderPath)) return null;
  const files = readdirSync(taskFolderPath);
  const match = files.find(f => f.startsWith(`${id}-`) && f.endsWith(`.${ext}`));
  return match ? join(taskFolderPath, match) : null;
}

/**
 * Find task file - checks both flat and folder structure
 */
function findTaskFile(id: number, ext: string, category?: string): string | null {
  const tasksDir = getTasksDir(category);
  // Check flat first, then folder
  return findTaskFileFlat(id, ext, tasksDir) || findTaskFileInFolder(id, ext, tasksDir);
}

interface FoundTaskFile {
  path: string;
  category?: string;
  inTaskFolder: boolean;
}

/**
 * Search for task file in any location (root, categories, with/without task folders)
 */
function findTaskFileAnywhere(id: number, ext: string): FoundTaskFile | null {
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

function getTaskFilePath(id: number, title: string, ext: string, category?: string, useTaskFolder?: boolean): string {
  const slug = slugify(title);
  const base = getTasksDir(category);
  if (useTaskFolder) {
    return join(base, String(id), `${id}-${slug}.${ext}`);
  }
  return join(base, `${id}-${slug}.${ext}`);
}

// ============= Types =============

type OutputFormat = "ai" | "md" | "json";

interface WorkItem {
  id: number;
  rev: number;
  title: string;
  state: string;
  changed: string;
  severity?: string;
  assignee?: string;
  tags?: string;
  description?: string;
  created?: string;
  createdBy?: string;
  changedBy?: string;
  url: string;
}

interface WorkItemFull extends WorkItem {
  comments: Comment[];
  relations?: Relation[];
}

interface Comment {
  id: number;
  author: string;
  date: string;
  text: string;
}

interface Relation {
  rel: string;
  url: string;
  attributes?: {
    name?: string;
    comment?: string;
  };
}

interface CacheEntry {
  id: number;
  changed: string;
  rev: number;
  title: string;
  state: string;
  severity?: string;
  assignee?: string;
  createdAt?: string;
  createdBy?: string;
  changedBy?: string;
  url: string;
}

interface WorkItemCache {
  id: number;
  rev: number;
  changed: string;
  title: string;
  state: string;
  commentCount: number;
  fetchedAt: string;
  category?: string;
  taskFolder?: boolean; // Whether stored in <id>/ subfolder
}

interface QueryCache {
  items: CacheEntry[];
  fetchedAt: string;
}

interface ChangeInfo {
  type: "new" | "updated";
  id: number;
  changes: string[];
  oldData?: CacheEntry;
  newData: CacheEntry;
}

// ============= Azure DevOps API Helpers =============

async function getAccessToken(): Promise<string> {
  const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
  return result.text().trim();
}

async function apiGet<T>(url: string): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function generateWorkItemUrl(config: AzureConfig, id: number): string {
  return `${config.org}/${encodeURIComponent(config.project)}/_workitems/edit/${id}`;
}

async function runQuery(config: AzureConfig, queryId: string): Promise<WorkItem[]> {
  const result = await $`az boards query --id ${queryId} -o json`.quiet();
  const items = JSON.parse(result.text());

  return items.map((item: Record<string, unknown>) => {
    const fields = item.fields as Record<string, unknown>;
    const id = item.id as number;
    return {
      id,
      rev: item.rev as number,
      title: fields?.["System.Title"] as string,
      state: fields?.["System.State"] as string,
      changed: fields?.["System.ChangedDate"] as string,
      severity: fields?.["Microsoft.VSTS.Common.Severity"] as string | undefined,
      assignee: (fields?.["System.AssignedTo"] as Record<string, unknown>)?.displayName as string | undefined,
      tags: fields?.["System.Tags"] as string | undefined,
      created: fields?.["System.CreatedDate"] as string | undefined,
      createdBy: (fields?.["System.CreatedBy"] as Record<string, unknown>)?.displayName as string | undefined,
      changedBy: (fields?.["System.ChangedBy"] as Record<string, unknown>)?.displayName as string | undefined,
      url: generateWorkItemUrl(config, id),
    };
  });
}

async function getWorkItem(config: AzureConfig, id: number): Promise<WorkItemFull> {
  const result = await $`az boards work-item show --id ${id} -o json`.quiet();
  const item = JSON.parse(result.text());

  // Get comments
  const commentsUrl = `${config.org}/${encodeURIComponent(config.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`;
  const commentsData = await apiGet<{ comments: Array<{ id: number; createdBy: { displayName: string }; createdDate: string; text: string }> }>(commentsUrl);

  return {
    id: item.id,
    rev: item.rev,
    title: item.fields?.["System.Title"],
    state: item.fields?.["System.State"],
    changed: item.fields?.["System.ChangedDate"],
    severity: item.fields?.["Microsoft.VSTS.Common.Severity"],
    assignee: item.fields?.["System.AssignedTo"]?.displayName,
    tags: item.fields?.["System.Tags"],
    description: item.fields?.["System.Description"],
    created: item.fields?.["System.CreatedDate"],
    createdBy: item.fields?.["System.CreatedBy"]?.displayName,
    changedBy: item.fields?.["System.ChangedBy"]?.displayName,
    url: generateWorkItemUrl(config, id),
    comments: (commentsData.comments || []).map(c => ({
      id: c.id,
      author: c.createdBy?.displayName,
      date: c.createdDate,
      text: c.text,
    })),
    relations: item.relations,
  };
}

async function getDashboard(config: AzureConfig, dashboardId: string): Promise<{ name: string; queries: Array<{ name: string; queryId: string }> }> {
  const dashboardsUrl = `${config.org}/${encodeURIComponent(config.project)}/_apis/dashboard/dashboards?api-version=7.1-preview.3`;
  const dashboardsData = await apiGet<{ value: Array<{ id: string; name: string; groupId?: string }> }>(dashboardsUrl);

  const dashboard = dashboardsData.value.find(d => d.id === dashboardId);
  if (!dashboard) {
    throw new Error(`Dashboard ${dashboardId} not found`);
  }

  const groupPath = dashboard.groupId ? `${config.projectId}/${dashboard.groupId}` : config.projectId;
  const widgetsUrl = `${config.org}/${groupPath}/_apis/Dashboard/Dashboards/${dashboardId}?api-version=7.1-preview.3`;
  const widgetsData = await apiGet<{ name: string; widgets: Array<{ name: string; settings: string }> }>(widgetsUrl);

  const queries: Array<{ name: string; queryId: string }> = [];
  for (const widget of widgetsData.widgets || []) {
    try {
      const settings = JSON.parse(widget.settings);
      const queryId = settings.queryId || settings.query?.queryId;
      if (queryId) {
        queries.push({ name: widget.name, queryId });
      }
    } catch {
      // Skip widgets without query settings
    }
  }

  return { name: widgetsData.name, queries };
}

// ============= Cache Management (using Storage utility) =============

async function loadGlobalCache<T>(type: "query" | "workitem" | "dashboard", id: string): Promise<T | null> {
  await storage.ensureDirs();
  return storage.getCacheFile<T>(`${type}-${id}.json`, CACHE_TTL);
}

async function saveGlobalCache<T>(type: "query" | "workitem" | "dashboard", id: string, data: T): Promise<void> {
  await storage.ensureDirs();
  await storage.putCacheFile(`${type}-${id}.json`, data, CACHE_TTL);
}

function detectChanges(oldItems: CacheEntry[], newItems: WorkItem[]): ChangeInfo[] {
  const changes: ChangeInfo[] = [];
  const oldMap = new Map(oldItems.map(item => [item.id, item]));

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
    const plainDesc = item.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    lines.push(plainDesc.slice(0, 500) + (plainDesc.length > 500 ? "..." : ""));
  }

  if (item.comments.length > 0) {
    lines.push("");
    lines.push(`## Comments (${item.comments.length})`);
    for (const comment of item.comments.slice(-5)) {
      lines.push("");
      lines.push(`**${comment.author}** (${new Date(comment.date).toLocaleDateString()}):`);
      const plainComment = comment.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      lines.push(plainComment.slice(0, 300) + (plainComment.length > 300 ? "..." : ""));
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

interface ParsedRelations {
  parent?: number;
  children: number[];
  related: number[];
  other: string[];
}

function parseRelations(relations: Relation[]): ParsedRelations {
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
    const plainDesc = item.description
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
    lines.push(plainDesc);
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
      const plainComment = comment.text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .trim();
      lines.push(plainComment);
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

// ============= URL Parsers =============

function extractQueryId(input: string): string {
  const match = input.match(/query\/([a-f0-9-]+)/i) || input.match(/^([a-f0-9-]+)$/i);
  if (!match) throw new Error(`Invalid query URL/ID: ${input}`);
  return match[1];
}

function extractWorkItemIds(input: string): number[] {
  const parts = input.split(",").map(s => s.trim()).filter(Boolean);
  const ids: number[] = [];

  for (const part of parts) {
    const match = part.match(/workItems?\/(\d+)/i) || part.match(/edit\/(\d+)/i) || part.match(/^(\d+)$/);
    if (!match) throw new Error(`Invalid work item URL/ID: ${part}`);
    ids.push(parseInt(match[1], 10));
  }

  return ids;
}

function extractDashboardId(input: string): string {
  const match = input.match(/dashboard\/([a-f0-9-]+)/i) || input.match(/^([a-f0-9-]+)$/i);
  if (!match) throw new Error(`Invalid dashboard URL/ID: ${input}`);
  return match[1];
}

// ============= Configuration Commands =============

interface ParsedUrl {
  org: string;
  project: string;
}

function parseAzureDevOpsUrl(url: string): ParsedUrl {
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
      org: `https://dev.azure.com/${vsMatch[1].toUpperCase()}`,
      project: decodeURIComponent(vsMatch[2]),
    };
  }

  throw new Error(`Could not parse Azure DevOps URL: ${url}\n\nSupported formats:\n  https://dev.azure.com/{org}/{project}/...\n  https://{org}.visualstudio.com/{project}/...`);
}

async function getProjectId(org: string, project: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${org}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get project info: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { id: string };
  return data.id;
}

async function handleConfigure(url: string): Promise<void> {
  console.log("🔧 Configuring Azure DevOps CLI...\n");

  // Check if logged in
  try {
    await $`az account show`.quiet();
  } catch {
    console.log(`
🔐 Azure CLI Authentication Required

You need to log in to Azure CLI first. Run:

  az login --allow-no-subscriptions --use-device-code

This will:
1. Display a code and URL
2. Open the URL in your browser
3. Enter the code to authenticate

Prerequisites:
  1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
  2. Install Azure DevOps extension: az extension add --name azure-devops

Documentation: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
`);
    process.exit(1);
  }

  console.log(`Parsing URL: ${url}\n`);

  const { org, project } = parseAzureDevOpsUrl(url);

  console.log(`  Organization: ${org}`);
  console.log(`  Project: ${project}`);

  console.log("\nFetching project ID from API...");

  const projectId = await getProjectId(org, project);
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

// ============= Main Commands =============

interface QueryFilters {
  states?: string[];
  severities?: string[];
}

async function handleQuery(input: string, format: OutputFormat, forceRefresh: boolean, filters?: QueryFilters, downloadWorkitems?: boolean, category?: string, taskFolders?: boolean): Promise<void> {
  const config = requireConfig();
  const queryId = extractQueryId(input);

  // Load old cache
  const rawCache = forceRefresh ? null : await loadGlobalCache<QueryCache>("query", queryId);
  const oldCache = rawCache?.items || null;
  const oldCacheTime = rawCache?.fetchedAt ? new Date(rawCache.fetchedAt) : undefined;

  // Run query
  let items = await runQuery(config, queryId);

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

  // Save to global cache
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
    console.log(`\n📥 Downloading ${items.length} work items${category ? ` to category: ${category}` : ""}${taskFolders ? " (with task folders)" : ""}...\n`);
    const ids = items.map(item => item.id).join(",");
    await handleWorkItem(ids, format, forceRefresh, category, taskFolders);
  }
}

interface WorkItemSettings {
  category?: string;
  taskFolder: boolean;
}

async function handleWorkItem(input: string, format: OutputFormat, forceRefresh: boolean, categoryArg?: string, taskFoldersArg?: boolean): Promise<void> {
  const config = requireConfig();
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
    const item = await getWorkItem(config, id);
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
  const dashboardId = extractDashboardId(input);

  const dashboard = await getDashboard(config, dashboardId);

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

Options:
  --format <ai|md|json>       Output format (default: ai)
  --force, --refresh          Force refresh, ignore cache
  --state <states>            Filter by state (comma-separated)
  --severity <sev>            Filter by severity (comma-separated)
  --download-workitems        With --query: download all work items to tasks/
  --category <name>           Save to tasks/<category>/ (remembered per work item)
  --task-folders              Save in tasks/<id>/ subfolder (only for new files)
  --help                      Show this help

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
    logger.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(`Unexpected error: ${err}`);
  process.exit(1);
});
