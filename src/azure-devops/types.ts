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
    /** Field change history (deltas). Populated when fetched with { updates: true } */
    updates?: WorkItemUpdate[];
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
        // Attachment-specific fields (populated when rel === "AttachedFile")
        resourceCreatedDate?: string;
        resourceModifiedDate?: string;
        resourceSize?: number;
        id?: number;
    };
}

export interface ParsedRelations {
    parent?: number;
    children: number[];
    related: number[];
    other: string[];
}

// ============= Attachment Types =============

export interface AttachmentInfo {
    /** GUID extracted from attachment URL */
    id: string;
    filename: string;
    size: number;
    createdDate: string;
    /** Full path on disk (set after download or if already exists) */
    localPath?: string;
    /** Whether this invocation downloaded the file (false = already existed) */
    downloaded?: boolean;
}

export interface AttachmentFilter {
    from?: Date;
    to?: Date;
    prefix?: string;
    suffix?: string;
    outputDir?: string;
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
    category?: string; // Query-level category (applied to new work items)
    taskFolders?: boolean; // Query-level task folder setting
}

export interface ChangeInfo {
    type: "new" | "updated";
    id: number;
    changes: string[];
    oldData?: CacheEntry;
    newData: CacheEntry;
}

// ============= History Types =============

/** Single field change in an update (oldValue → newValue) */
export interface FieldChange<T = unknown> {
    oldValue?: T;
    newValue?: T;
}

/** Identity reference from Azure DevOps (used in updates/revisions) */
export interface IdentityRef {
    displayName: string;
    uniqueName?: string;
    id?: string;
    imageUrl?: string;
}

/** Relation change in an update */
export interface RelationChange {
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
}

/** Single update record from /wit/workItems/{id}/updates API */
export interface WorkItemUpdate {
    id: number;
    workItemId: number;
    rev: number;
    revisedBy: IdentityRef;
    revisedDate: string;
    fields?: Record<string, FieldChange>;
    relations?: {
        added?: RelationChange[];
        removed?: RelationChange[];
        updated?: RelationChange[];
    };
    url: string;
}

/** Cached history for a work item */
export interface WorkItemHistory {
    workItemId: number;
    updates: WorkItemUpdate[];
    fetchedAt: string;
    assignmentPeriods: AssignmentPeriod[];
    statePeriods: StatePeriod[];
}

/** Period when someone was assigned */
export interface AssignmentPeriod {
    assignee: string;
    assigneeNormalized: string;
    startDate: string;
    endDate: string | null;
    durationMinutes: number | null;
}

/** Period in a specific state */
export interface StatePeriod {
    state: string;
    startDate: string;
    endDate: string | null;
    durationMinutes: number | null;
    assigneeDuring?: string;
}

/** Batch response from /reporting/workitemrevisions API */
export interface ReportingRevisionsResponse {
    values: ReportingRevision[];
    continuationToken?: string;
    isLastBatch: boolean;
}

/** Single revision from reporting API (full field values, not deltas) */
export interface ReportingRevision {
    id: number;
    rev: number;
    fields: Record<string, unknown>;
}

/** WIQL query response (returns IDs only) */
export interface WiqlResponse {
    queryType: string;
    asOf?: string;
    workItems: Array<{ id: number; url: string }>;
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
    changesFrom?: Date; // Only show changes after this date
    changesTo?: Date; // Only show changes before this date
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
    name: string; // e.g., "Severity"
    referenceName: string; // e.g., "Microsoft.VSTS.Common.Severity"
    alwaysRequired: boolean;
    helpText?: string;
    allowedValues?: string[]; // Valid options from API
    defaultValue?: string;
}

/** State definition with color for work item type */
export interface WorkItemStateColor {
    name: string; // e.g., "New", "Active", "Closed"
    color: string;
    category: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed";
}

/** Template for creating work items (for LLM consumption) */
export interface WorkItemTemplate {
    $schema: "azure-devops-workitem-v1";
    type: WorkItemType;
    fields: Record<string, unknown>; // Dynamic based on type definition
    relations?: {
        parent?: number;
        children?: number[];
        related?: number[];
    };
    _hints?: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[]; // From API
            usedValues?: string[]; // From query analysis (common values)
            defaultValue?: string;
            examples?: string[];
        }
    >;
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
    areas: string[]; // Actual areas in use
    iterations: string[]; // Actual iterations in use
    severities: string[]; // Severity values used
    tags: string[]; // Tags used (sorted by frequency)
    assignees: string[]; // Active assignees
    parents: { id: number; title: string }[]; // Common parent work items
}

/** Query information from Azure DevOps */
export interface QueryInfo {
    id: string;
    name: string;
    path: string; // Full folder path like "Shared Queries/Bugs/Open"
    isFolder: boolean;
}

/** Cache for all queries in a project */
export interface QueriesCache {
    project: string;
    queries: QueryInfo[];
    fetchedAt: string;
}

// ============= TimeLog Types (Third-Party Extension) =============

/** Time type definition from TimeLog API */
export interface TimeType {
    timeTypeId: string; // "3626529b-6efd-4c02-9800-861f9c0f9206"
    description: string; // "Development", "Code Review", etc.
    projectId: string | null; // null = org-wide
    isDefaultForProject: boolean;
    disabled: boolean;
}

/** Time log entry from GET response */
export interface TimeLogEntry {
    timeLogId: string; // "9a016275-6d8f-4e6f-9f8f-052f34e5b177"
    comment: string; // "analýza, fixing"
    week: string; // "2026-W06" (ISO week)
    timeTypeDescription: string; // "Development"
    minutes: number; // 120 (NOT hours!)
    date: string; // "2026-02-04" (YYYY-MM-DD)
    userId: string; // "57c2e420-edce-6083-8a6a-a58deb1c6769"
    userName: string; // "John Doe"
    userEmail: string; // "user@example.com"
}

/** User info for TimeLog API */
export interface TimeLogUser {
    userId: string;
    userName: string;
    userEmail: string;
}

/** Request body for creating a time log entry */
export interface CreateTimeLogRequest {
    minutes: number; // 120 = 2 hours
    timeTypeDescription: string; // "Development" (display name, not UUID!)
    comment: string; // "analýza, fixing"
    date: string; // "2026-02-04"
    workItemId: number; // 268935
    projectId: string; // "de25c7dd-75d8-467a-bac0-f15fac9b560d"
    users: TimeLogUser[];
    userMakingChange: string; // "John Doe"
}

/** Response from POST /timelogs/ */
export interface CreateTimeLogResponse {
    logsCreated: string[]; // ["9a016275-6d8f-4e6f-9f8f-052f34e5b177"]
}

/** Allowed work item type configuration for time logging precheck */
export interface AllowedTypeConfig {
    allowedWorkItemTypes: string[];
    allowedStatesPerType?: Record<string, string[]>;
    deprioritizedStates?: string[];
    defaultUserName?: string;
}

/** TimeLog configuration stored in config.json */
export interface TimeLogConfig {
    functionsKey: string; // API key for Azure Functions
    defaultUser?: TimeLogUser; // Cached user info
    allowedWorkItemTypes?: string[]; // e.g., ["Bug", "Task"]
    allowedStatesPerType?: Record<string, string[]>; // e.g., { "Task": ["In Progress"], "Bug": ["New","Development","Blocked"] }
    deprioritizedStates?: string[]; // e.g., ["Closed", "Done", "Resolved"] — used as fallback in precheck
}

/** Extended config with TimeLog settings */
export interface AzureConfigWithTimeLog extends AzureConfig {
    orgId?: string; // Organization ID (GUID)
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

/** Query parameters for /timelog/query endpoint */
export interface TimeLogQueryParams {
    FromDate?: string; // YYYY-MM-DD
    ToDate?: string; // YYYY-MM-DD
    projectId?: string; // GUID
    workitemId?: number;
    userId?: string; // Azure AD object ID (GUID)
}

/** Response from /timelog/query endpoint (richer than TimeLogEntry) */
export interface TimeLogQueryEntry {
    timeLogId: string;
    comment: string | null;
    week: string; // "2026-W05" (ISO week)
    timeTypeId: string;
    timeTypeDescription: string;
    minutes: number;
    date: string; // "2026-01-30T00:00:00"
    userId: string;
    userName: string;
    userEmail: string | null;
    projectId: string;
    workItemId: number;
    createdOn: string;
    createdBy: string;
    updatedOn: string | null;
    updatedBy: string | null;
    deletedOn: string | null;
    deletedBy: string | null;
}
