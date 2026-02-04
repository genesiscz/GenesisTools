/**
 * Azure DevOps CLI Tool - Type Definitions
 *
 * This file contains all TypeScript interfaces and type aliases used by the
 * Azure DevOps CLI tool. Types are organized into logical groups:
 * - Configuration types
 * - Work item types
 * - Cache types
 * - Utility types
 */

// ============= Configuration Types =============

export interface AzureConfig {
  org: string;
  project: string;
  projectId: string;
  apiResource: string;
}

// ============= Output Types =============

export type OutputFormat = "ai" | "md" | "json";

// ============= Work Item Types =============

/** Raw response from Azure DevOps CLI `az boards work-item show` */
export interface AzWorkItemRaw {
  id: number;
  rev: number;
  fields?: Record<string, unknown>;
  relations?: Relation[];
}

export interface WorkItem {
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

export interface WorkItemFull extends WorkItem {
  comments: Comment[];
  relations?: Relation[];
  /** Raw field values from Azure DevOps API (keyed by reference name, e.g., "System.AreaPath") */
  rawFields?: Record<string, unknown>;
}

export interface Comment {
  id: number;
  author: string;
  date: string;
  text: string;
}

export interface Relation {
  rel: string;
  url: string;
  attributes?: {
    name?: string;
    comment?: string;
  };
}

export interface ParsedRelations {
  parent?: number;
  children: number[];
  related: number[];
  other: string[];
}

// ============= Cache Types =============

/** Metadata from fresh query results for smart cache comparison */
export interface QueryItemMetadata {
  id: number;
  changed: string;
  rev: number;
}

export interface CacheEntry {
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

export interface WorkItemCache {
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

export interface QueryCache {
  items: CacheEntry[];
  fetchedAt: string;
  category?: string;      // Query-level category (applied to new work items)
  taskFolders?: boolean;  // Query-level task folder setting
}

export interface ChangeInfo {
  type: "new" | "updated";
  id: number;
  changes: string[];
  oldData?: CacheEntry;
  newData: CacheEntry;
}

// ============= Utility Types =============

export interface FoundTaskFile {
  path: string;
  category?: string;
  inTaskFolder: boolean;
}

export interface ParsedUrl {
  org: string;
  project: string;
}

export interface QueryFilters {
  states?: string[];
  severities?: string[];
  changesFrom?: Date;  // Only show changes after this date
  changesTo?: Date;    // Only show changes before this date
}

export interface WorkItemSettings {
  category?: string;
  taskFolder: boolean;
}

// ============= Create Feature Types =============

/** Work item type names supported by Azure DevOps */
export type WorkItemType = "Bug" | "Task" | "User Story" | "Incident" | "Feature" | "Epic";

/** API Response: Work Item Type Definition from Azure DevOps */
export interface WorkItemTypeDefinition {
  name: string;
  referenceName: string;
  description: string;
  color: string;
  icon: { id: string; url: string };
  isDisabled: boolean;
  fields: WorkItemTypeFieldInstance[];
  fieldInstances: WorkItemTypeFieldInstance[];
  states: WorkItemStateColor[];
  transitions: Record<string, { to: string; actions?: string[] }[]>;
}

/** Field definition within a work item type */
export interface WorkItemTypeFieldInstance {
  name: string;               // e.g., "Severity"
  referenceName: string;      // e.g., "Microsoft.VSTS.Common.Severity"
  alwaysRequired: boolean;
  helpText?: string;
  allowedValues?: string[];   // Valid options from API
  defaultValue?: string;
}

/** State definition with color for work item type */
export interface WorkItemStateColor {
  name: string;               // e.g., "New", "Active", "Closed"
  color: string;
  category: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed";
}

/** Template for creating work items (for LLM consumption) */
export interface WorkItemTemplate {
  $schema: "azure-devops-workitem-v1";
  type: WorkItemType;
  fields: Record<string, unknown>;  // Dynamic based on type definition
  relations?: {
    parent?: number;
    children?: number[];
    related?: number[]
  };
  _hints?: Record<string, {
    description: string;
    required?: boolean;
    allowedValues?: string[];    // From API
    usedValues?: string[];       // From query analysis (common values)
    defaultValue?: string;
    examples?: string[];
  }>;
  _source?: {
    queryId?: string;
    workItemId?: number;
    typeDefinitionUrl?: string;
    analyzedItemCount?: number;
    generatedAt: string;
  };
}

/** JSON Patch operation for Azure DevOps API */
export interface JsonPatchOperation {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/** Cached usage data extracted from query results */
export interface UsedValuesCache {
  project: string;
  queryId?: string;
  fetchedAt: string;
  areas: string[];       // Actual areas in use
  iterations: string[];  // Actual iterations in use
  severities: string[];  // Severity values used
  tags: string[];        // Tags used (sorted by frequency)
  assignees: string[];   // Active assignees
  parents: { id: number; title: string }[];  // Common parent work items
}

/** Options for the --create command */
export interface CreateOptions {
  interactive: boolean;
  fromFile?: string;
  type?: WorkItemType;
  sourceInput?: string;
  title?: string;
  description?: string;
  area?: string;
  iteration?: string;
  severity?: string;
  tags?: string;
  assignee?: string;
  parent?: string;
}

/** Cached work item type definitions */
export interface TypeDefinitionCache {
  project: string;
  types: Record<string, WorkItemTypeDefinition>;
  fetchedAt: string;
}

/** Query information from Azure DevOps */
export interface QueryInfo {
  id: string;
  name: string;
  path: string;  // Full folder path like "Shared Queries/Bugs/Open"
  isFolder: boolean;
}

/** Cache for all queries in a project */
export interface QueriesCache {
  project: string;
  queries: QueryInfo[];
  fetchedAt: string;
}

// ============= TimeLog Types (Third-Party Extension) =============

/** TimeLog API base URL */
export const TIMELOG_API_BASE = "https://boznet-timelogapi.azurewebsites.net/api";

/** Time type definition from TimeLog API */
export interface TimeType {
  timeTypeId: string;          // "3626529b-6efd-4c02-9800-861f9c0f9206"
  description: string;         // "Development", "Code Review", etc.
  projectId: string | null;    // null = org-wide
  isDefaultForProject: boolean;
  disabled: boolean;
}

/** Time log entry from GET response */
export interface TimeLogEntry {
  timeLogId: string;           // "9a016275-6d8f-4e6f-9f8f-052f34e5b177"
  comment: string;             // "analýza, fixing"
  week: string;                // "2026-W06" (ISO week)
  timeTypeDescription: string; // "Development"
  minutes: number;             // 120 (NOT hours!)
  date: string;                // "2026-02-04" (YYYY-MM-DD)
  userId: string;              // "57c2e420-edce-6083-8a6a-a58deb1c6769"
  userName: string;            // "Foltýn Martin (QK)"
  userEmail: string;           // "martin.foltyn@cez.cz"
}

/** User info for TimeLog API */
export interface TimeLogUser {
  userId: string;
  userName: string;
  userEmail: string;
}

/** Request body for creating a time log entry */
export interface CreateTimeLogRequest {
  minutes: number;             // 120 = 2 hours
  timeTypeDescription: string; // "Development" (display name, not UUID!)
  comment: string;             // "analýza, fixing"
  date: string;                // "2026-02-04"
  workItemId: number;          // 268935
  projectId: string;           // "de25c7dd-75d8-467a-bac0-f15fac9b560d"
  users: TimeLogUser[];
  userMakingChange: string;    // "Foltýn Martin (QK)"
}

/** Response from POST /timelogs/ */
export interface CreateTimeLogResponse {
  logsCreated: string[];       // ["9a016275-6d8f-4e6f-9f8f-052f34e5b177"]
}

/** TimeLog configuration stored in config.json */
export interface TimeLogConfig {
  functionsKey: string;        // API key for Azure Functions
  defaultUser?: TimeLogUser;   // Cached user info
}

/** Extended config with TimeLog settings */
export interface AzureConfigWithTimeLog extends AzureConfig {
  orgId?: string;              // Organization ID (GUID)
  timelog?: TimeLogConfig;
}

/** Options for timelog add command */
export interface TimeLogAddOptions {
  workitem?: string;
  hours?: string;
  minutes?: string;
  type?: string;
  date?: string;
  comment?: string;
  interactive?: boolean;
}

/** Options for timelog list command */
export interface TimeLogListOptions {
  workitem: string;
  format?: "ai" | "md" | "json";
}

/** JSON import file format */
export interface TimeLogImportFile {
  entries: Array<{
    workItemId: number;
    hours?: number;
    minutes?: number;
    timeType: string;
    date: string;
    comment?: string;
  }>;
}
