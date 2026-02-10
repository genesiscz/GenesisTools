/**
 * Azure DevOps CLI Tool - API Module
 *
 * This file contains the Api class that encapsulates all Azure DevOps API
 * interactions, including authentication, querying, and data retrieval.
 */

import { loadTeamMembersCache, saveTeamMembersCache } from "@app/azure-devops/cache";
import type {
    AzureConfig,
    AzWorkItemRaw,
    Comment,
    IdentityRef,
    JsonPatchOperation,
    QueryInfo,
    ReportingRevision,
    ReportingRevisionsResponse,
    WiqlResponse,
    WorkItem,
    WorkItemFull,
    WorkItemType,
    WorkItemTypeDefinition,
    WorkItemUpdate,
} from "@app/azure-devops/types";
import logger from "@app/logger";
import { buildUrl } from "@app/utils/url";
import { $ } from "bun";

// Azure DevOps API resource ID (constant for all Azure DevOps organizations)
export const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * Dashboard information returned from the API
 */
export interface Dashboard {
    name: string;
    queries: Array<{ name: string; queryId: string }>;
}

/**
 * Query node from Azure DevOps Queries API
 */
interface QueryNode {
    id: string;
    name: string;
    path: string;
    isFolder: boolean;
    hasChildren?: boolean;
    children?: QueryNode[];
}

/**
 * Api class for Azure DevOps interactions
 *
 * Encapsulates all API calls to Azure DevOps, including:
 * - Authentication via Azure CLI
 * - Work item queries
 * - Work item details with comments
 * - Dashboard information
 */
export class Api {
    private config: AzureConfig;
    private cachedToken: string | null = null;
    private tokenExpiry: number = 0;

    constructor(config: AzureConfig) {
        this.config = config;
    }

    // ============= Static URL Builders =============
    // Project segment is auto-encoded. Other path segments are NOT auto-encoded
    // (caller encodes when needed, e.g., work item type names with spaces).

    private static filterParams(params?: Record<string, string | undefined>): Record<string, string> | undefined {
        if (!params) return undefined;
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) result[k] = v;
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }

    /**
     * Project-scoped WIT API URL: `{org}/{project}/_apis/wit/{path}?api-version=7.1`
     */
    static witUrl(config: AzureConfig, path: string | string[], queryParams?: Record<string, string | undefined>): string {
        const segments = Array.isArray(path) ? path : [path];
        return buildUrl({
            base: config.org,
            segments: [encodeURIComponent(config.project), "_apis", "wit", ...segments],
            queryParams: { "api-version": "7.1", ...Api.filterParams(queryParams) },
        });
    }

    /**
     * Project-scoped WIT API URL with preview version.
     * Default: `7.1-preview.3` (used for comments endpoint).
     */
    static witUrlPreview(config: AzureConfig, path: string | string[], queryParams?: Record<string, string | undefined>, version = "7.1-preview.3"): string {
        const segments = Array.isArray(path) ? path : [path];
        return buildUrl({
            base: config.org,
            segments: [encodeURIComponent(config.project), "_apis", "wit", ...segments],
            queryParams: { "api-version": version, ...Api.filterParams(queryParams) },
        });
    }

    /**
     * Project-scoped non-WIT API URL (dashboard, etc.).
     * `{org}/{project}/_apis/{resource}/{path}?api-version=...`
     */
    static projectApiUrl(config: AzureConfig, path: string[], queryParams?: Record<string, string | undefined>, apiVersion = "7.1"): string {
        return buildUrl({
            base: config.org,
            segments: [encodeURIComponent(config.project), "_apis", ...path],
            queryParams: { "api-version": apiVersion, ...Api.filterParams(queryParams) },
        });
    }

    /**
     * Org-scoped API URL (no project in path).
     * `{org}/_apis/{path}?api-version=7.1`
     */
    static orgUrl(config: AzureConfig, path: string[], queryParams?: Record<string, string | undefined>): string {
        return buildUrl({
            base: config.org,
            segments: ["_apis", ...path],
            queryParams: { "api-version": "7.1", ...Api.filterParams(queryParams) },
        });
    }

    /**
     * Org-scoped URL from raw org string (for static methods that don't have a config).
     */
    static orgUrlRaw(org: string, path: string[], queryParams?: Record<string, string | undefined>): string {
        return buildUrl({
            base: org,
            segments: ["_apis", ...path],
            queryParams: { "api-version": "7.1", ...Api.filterParams(queryParams) },
        });
    }

    /**
     * Work item web UI URL (not API, no api-version).
     * `{org}/{project}/_workitems/edit/{id}`
     */
    static workItemWebUrl(config: AzureConfig, id: number): string {
        return buildUrl({
            base: config.org,
            segments: [encodeURIComponent(config.project), "_workitems", "edit", String(id)],
        });
    }

    // ============= Private HTTP Helpers =============

    /**
     * Get an access token for Azure DevOps API using Azure CLI
     * Caches token for 5 minutes to avoid repeated az CLI calls
     */
    private async getAccessToken(): Promise<string> {
        // Return cached token if still valid (with 1 minute buffer)
        if (this.cachedToken && Date.now() < this.tokenExpiry - 60000) {
            logger.debug("[api] Using cached access token");
            return this.cachedToken;
        }

        logger.debug("[api] Fetching new access token via: az account get-access-token");
        try {
            const result =
                await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
            const token = result.text().trim();
            if (!token) {
                throw new Error("Empty token received. Ensure you're logged in with 'az login'");
            }
            // Cache token for 5 minutes
            this.cachedToken = token;
            this.tokenExpiry = Date.now() + 5 * 60 * 1000;
            logger.debug("[api] Access token obtained and cached");
            return token;
        } catch (error) {
            const stderr = (error as { stderr?: { toString(): string } })?.stderr?.toString?.()?.trim();
            const message = stderr || (error instanceof Error ? error.message : String(error));
            throw new Error(`Failed to get Azure access token:\n${message}`);
        }
    }

    /**
     * Execute an az CLI command with logging
     */
    private async azCommand<T>(command: string[], description: string): Promise<T> {
        const cmdStr = command.join(" ");
        logger.debug(`[api] ${description}`);
        logger.debug(`[api] Running: az ${cmdStr}`);
        const startTime = Date.now();

        try {
            const result = await $`az ${command}`.quiet();
            const text = result.text();
            const elapsed = Date.now() - startTime;
            logger.debug(`[api] az command completed in ${elapsed}ms`);

            if (!text.trim()) {
                throw new Error(`Empty response from az ${command[0]}`);
            }
            const parsed = JSON.parse(text) as T;
            return parsed;
        } catch (error) {
            const stderr = (error as { stderr?: { toString(): string } })?.stderr?.toString?.()?.trim();
            const message = stderr || (error instanceof Error ? error.message : String(error));
            throw new Error(`az ${command[0]} failed: ${message}`);
        }
    }

    /**
     * Make an HTTP request with logging and error handling
     */
    private async request<T>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        url: string,
        options: { body?: unknown; contentType?: string; description?: string } = {}
    ): Promise<T> {
        const { body, contentType = "application/json", description } = options;
        const shortUrl = url.replace(this.config.org, "").slice(0, 80);

        logger.debug(`[api] ${method} ${shortUrl}${description ? ` (${description})` : ""}`);
        const startTime = Date.now();

        const token = await this.getAccessToken();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
        };
        if (body !== undefined) {
            headers["Content-Type"] = contentType;
        }

        const response = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const elapsed = Date.now() - startTime;
        logger.debug(`[api] ${method} response: ${response.status} ${response.statusText} (${elapsed}ms)`);

        if (!response.ok) {
            const errorText = await response.text();
            logger.debug(`[api] Error response body: ${errorText.slice(0, 200)}`);
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }

        return response.json();
    }

    /**
     * Make a GET request to the Azure DevOps API
     */
    private async get<T>(url: string, description?: string): Promise<T> {
        return this.request<T>("GET", url, { description });
    }

    /**
     * Make a POST request to the Azure DevOps API
     */
    private async post<T>(
        url: string,
        body: unknown,
        contentType = "application/json",
        description?: string
    ): Promise<T> {
        return this.request<T>("POST", url, { body, contentType, description });
    }

    /**
     * Generate the URL for a work item in Azure DevOps web UI
     */
    generateWorkItemUrl(id: number): string {
        return `${this.config.org}/${encodeURIComponent(this.config.project)}/_workitems/edit/${id}`;
    }

    /**
     * Run a saved query and return the work items with full field data
     * Uses REST API to get ChangedDate and other fields not returned by az boards query
     */
    async runQuery(queryId: string): Promise<WorkItem[]> {
        // Step 1: Run the query to get work item IDs
        const queryUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/wiql/${queryId}?api-version=7.1`;
        const queryResult = await this.get<{ workItems?: Array<{ id: number; url: string }> }>(
            queryUrl,
            `query ${queryId.slice(0, 8)}`
        );

        if (!queryResult.workItems || queryResult.workItems.length === 0) {
            logger.debug(`[api] Query returned 0 work items`);
            return [];
        }

        const ids = queryResult.workItems.map((wi) => wi.id);
        logger.debug(`[api] Query returned ${ids.length} work item IDs`);

        // Step 2: Batch fetch work items with specific fields (max 200 per request)
        const fields = [
            "System.Id",
            "System.Rev",
            "System.Title",
            "System.State",
            "System.ChangedDate",
            "System.ChangedBy",
            "System.CreatedDate",
            "System.CreatedBy",
            "System.AssignedTo",
            "System.Tags",
            "Microsoft.VSTS.Common.Severity",
        ].join(",");

        const allItems: WorkItem[] = [];
        const batchSize = 200;

        for (let i = 0; i < ids.length; i += batchSize) {
            const batchIds = ids.slice(i, i + batchSize);
            const idsParam = batchIds.join(",");
            const itemsUrl = `${this.config.org}/_apis/wit/workitems?ids=${idsParam}&fields=${fields}&api-version=7.1`;
            const itemsResult = await this.get<{
                value: Array<{ id: number; rev: number; fields: Record<string, unknown> }>;
            }>(itemsUrl, `batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(ids.length / batchSize)}`);

            for (const item of itemsResult.value) {
                const f = item.fields;
                allItems.push({
                    id: item.id,
                    rev: item.rev,
                    title: f["System.Title"] as string,
                    state: f["System.State"] as string,
                    changed: f["System.ChangedDate"] as string,
                    severity: f["Microsoft.VSTS.Common.Severity"] as string | undefined,
                    assignee: (f["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName,
                    tags: f["System.Tags"] as string | undefined,
                    created: f["System.CreatedDate"] as string | undefined,
                    createdBy: (f["System.CreatedBy"] as { displayName?: string } | undefined)?.displayName,
                    changedBy: (f["System.ChangedBy"] as { displayName?: string } | undefined)?.displayName,
                    url: this.generateWorkItemUrl(item.id),
                });
            }
        }

        logger.debug(`[api] Fetched ${allItems.length} work items with fields`);
        return allItems;
    }

    /**
     * Get full details of a work item including comments and relations
     */
    async getWorkItem(id: number): Promise<WorkItemFull> {
        const item = await this.azCommand<AzWorkItemRaw>(
            ["boards", "work-item", "show", "--id", String(id), "-o", "json"],
            `Fetching work item #${id}`
        );

        // Get comments via REST API
        const commentsUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`;
        const commentsData = await this.get<{
            comments: Array<{ id: number; createdBy: { displayName: string }; createdDate: string; text: string }>;
        }>(commentsUrl, `comments for #${id}`);
        logger.debug(`[api] Work item #${id} has ${commentsData.comments?.length || 0} comments`);

        const fields = item.fields;

        return {
            id: item.id,
            rev: item.rev,
            title: fields?.["System.Title"] as string,
            state: fields?.["System.State"] as string,
            changed: fields?.["System.ChangedDate"] as string,
            severity: fields?.["Microsoft.VSTS.Common.Severity"] as string | undefined,
            assignee: (fields?.["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName,
            tags: fields?.["System.Tags"] as string | undefined,
            description: fields?.["System.Description"] as string | undefined,
            created: fields?.["System.CreatedDate"] as string | undefined,
            createdBy: (fields?.["System.CreatedBy"] as { displayName?: string } | undefined)?.displayName,
            changedBy: (fields?.["System.ChangedBy"] as { displayName?: string } | undefined)?.displayName,
            url: this.generateWorkItemUrl(id),
            comments: (commentsData.comments || []).map(
                (c): Comment => ({
                    id: c.id,
                    author: c.createdBy?.displayName,
                    date: c.createdDate,
                    text: c.text,
                })
            ),
            relations: item.relations,
            rawFields: fields,
        };
    }

    /**
     * Get dashboard information including all queries it contains
     */
    async getDashboard(dashboardId: string): Promise<Dashboard> {
        logger.debug(`[api] Fetching dashboard ${dashboardId.slice(0, 8)}...`);
        const dashboardsUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/dashboard/dashboards?api-version=7.1-preview.3`;
        const dashboardsData = await this.get<{ value: Array<{ id: string; name: string; groupId?: string }> }>(
            dashboardsUrl,
            "list dashboards"
        );

        const dashboard = dashboardsData.value.find((d) => d.id === dashboardId);
        if (!dashboard) {
            throw new Error(`Dashboard ${dashboardId} not found`);
        }
        logger.debug(`[api] Found dashboard: "${dashboard.name}"`);

        const groupPath = dashboard.groupId ? `${this.config.projectId}/${dashboard.groupId}` : this.config.projectId;
        const widgetsUrl = `${this.config.org}/${groupPath}/_apis/Dashboard/Dashboards/${dashboardId}?api-version=7.1-preview.3`;
        const widgetsData = await this.get<{ name: string; widgets: Array<{ name: string; settings: string }> }>(
            widgetsUrl,
            "dashboard widgets"
        );
        logger.debug(`[api] Dashboard has ${widgetsData.widgets?.length || 0} widgets`);

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

    /**
     * Create a new work item using JSON Patch operations
     *
     * @param type - Work item type (Bug, Task, User Story, etc.)
     * @param operations - JSON Patch operations to set field values
     * @returns The created work item with full details
     *
     * @example
     * const operations: JsonPatchOperation[] = [
     *   { op: "add", path: "/fields/System.Title", value: "Bug title" },
     *   { op: "add", path: "/fields/System.Description", value: "Description" },
     * ];
     * const workItem = await api.createWorkItem("Bug", operations);
     */
    async createWorkItem(type: WorkItemType, operations: JsonPatchOperation[]): Promise<WorkItemFull> {
        logger.debug(`[api] Creating work item of type: ${type}`);
        logger.debug(`[api] Operations: ${operations.map((o) => o.path).join(", ")}`);
        const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`;

        const result = await this.post<Record<string, unknown>>(
            url,
            operations,
            "application/json-patch+json",
            `create ${type}`
        );
        logger.debug(`[api] Created work item #${result.id}`);

        // Transform API response to WorkItemFull format
        const fields = result.fields as Record<string, unknown>;
        const id = result.id as number;

        return {
            id,
            rev: result.rev as number,
            title: fields?.["System.Title"] as string,
            state: fields?.["System.State"] as string,
            changed: fields?.["System.ChangedDate"] as string,
            severity: fields?.["Microsoft.VSTS.Common.Severity"] as string | undefined,
            assignee: (fields?.["System.AssignedTo"] as Record<string, unknown>)?.displayName as string | undefined,
            tags: fields?.["System.Tags"] as string | undefined,
            description: fields?.["System.Description"] as string | undefined,
            created: fields?.["System.CreatedDate"] as string | undefined,
            createdBy: (fields?.["System.CreatedBy"] as Record<string, unknown>)?.displayName as string | undefined,
            changedBy: (fields?.["System.ChangedBy"] as Record<string, unknown>)?.displayName as string | undefined,
            url: this.generateWorkItemUrl(id),
            comments: [], // New work item has no comments
            relations: result.relations as WorkItemFull["relations"],
        };
    }

    /**
     * Get the definition of a work item type including fields, states, and transitions
     */
    async getWorkItemTypeDefinition(type: WorkItemType): Promise<WorkItemTypeDefinition> {
        logger.debug(`[api] Fetching type definition for: ${type}`);
        const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}?api-version=7.1`;
        return this.get<WorkItemTypeDefinition>(url, `type definition: ${type}`);
    }

    /**
     * Get list of available (non-disabled) work item types in the project
     */
    async getAvailableWorkItemTypes(): Promise<WorkItemType[]> {
        logger.debug("[api] Fetching available work item types");
        const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitemtypes?api-version=7.1`;
        const result = await this.get<{ value: WorkItemTypeDefinition[] }>(url, "work item types");
        const types = result.value.filter((t) => !t.isDisabled).map((t) => t.name as WorkItemType);
        logger.debug(`[api] Found ${types.length} available work item types`);
        return types;
    }

    /**
     * Get all queries from the project (flat list)
     * Recursively fetches queries from all folders
     */
    async getAllQueries(): Promise<QueryInfo[]> {
        logger.debug("[api] Fetching all queries from project");
        const queries: QueryInfo[] = [];

        // Azure DevOps Queries API - get root level queries
        const rootUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/queries?$depth=2&api-version=7.1`;
        const rootData = await this.get<{ value: QueryNode[] }>(rootUrl, "root queries");

        // Recursively process query tree
        const processNode = async (node: QueryNode, parentPath: string): Promise<void> => {
            const path = parentPath ? `${parentPath}/${node.name}` : node.name;

            if (node.isFolder) {
                queries.push({
                    id: node.id,
                    name: node.name,
                    path,
                    isFolder: true,
                });

                // If folder has children, process them
                if (node.children) {
                    for (const child of node.children) {
                        await processNode(child, path);
                    }
                } else if (node.hasChildren) {
                    // Need to fetch children
                    const childUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/queries/${node.id}?$depth=2&api-version=7.1`;
                    try {
                        const childData = await this.get<QueryNode>(childUrl);
                        if (childData.children) {
                            for (const child of childData.children) {
                                await processNode(child, path);
                            }
                        }
                    } catch {
                        // Skip folders we can't access
                    }
                }
            } else {
                // It's a query
                queries.push({
                    id: node.id,
                    name: node.name,
                    path,
                    isFolder: false,
                });
            }
        };

        for (const node of rootData.value || []) {
            await processNode(node, "");
        }

        logger.debug(`[api] Found ${queries.length} total queries`);
        return queries;
    }

    // ============= History & Reporting Methods =============

    async runWiql(wiql: string, options?: { top?: number }): Promise<WiqlResponse> {
        const params = new URLSearchParams({ "api-version": "7.1" });
        if (options?.top) params.set("$top", String(options.top));
        const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/wiql?${params}`;
        return this.post<WiqlResponse>(url, { query: wiql }, "application/json", "WIQL query");
    }

    /**
     * Execute WIQL query with ASOF clause for point-in-time queries.
     * @note Two-step process: WIQL returns IDs, then GET /workItems?asOf=... for full data.
     * @note Could be useful for: "What items were Active on Jan 1, 2024?"
     */
    async runWiqlWithAsOf(wiql: string, asOf: string): Promise<WiqlResponse> {
        const fullWiql = wiql.includes("ASOF") ? wiql : `${wiql} ASOF '${asOf}'`;
        return this.runWiql(fullWiql);
    }

    /**
     * Fetch all updates (field change deltas) for a single work item.
     * @note No batch endpoint exists - must call per work item.
     * @note For bulk sync, use getReportingRevisions() instead.
     */
    async getWorkItemUpdates(id: number): Promise<WorkItemUpdate[]> {
        const updates: WorkItemUpdate[] = [];
        let skip = 0;
        const top = 200;
        while (true) {
            const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workItems/${id}/updates?$top=${top}&$skip=${skip}&api-version=7.1`;
            const data = await this.get<{ count: number; value: WorkItemUpdate[] }>(
                url,
                `updates for #${id} (skip=${skip})`
            );
            updates.push(...data.value);
            if (data.value.length < top) break;
            skip += top;
        }
        return updates;
    }

    /**
     * Fetch revisions in batch using reporting API.
     * @note Cannot filter by work item ID server-side - fetches ENTIRE project, filters client-side.
     * @note For <20 items, per-item getWorkItemUpdates() may be faster.
     */
    async getReportingRevisions(
        options: {
            workItemIds?: number[];
            startDateTime?: Date;
            fields?: string[];
            maxPageSize?: number;
            onProgress?: (info: { page: number; matchedItems: number; totalRevisions: number }) => void;
        } = {}
    ): Promise<Map<number, ReportingRevision[]>> {
        const fields = options.fields || [
            "System.Id",
            "System.Rev",
            "System.State",
            "System.AssignedTo",
            "System.ChangedDate",
            "System.ChangedBy",
            "System.Title",
        ];
        const body = { fields, includeIdentityRef: true, includeLatestOnly: false };
        const revisionsByItem = new Map<number, ReportingRevision[]>();
        let continuationToken: string | undefined;
        const maxPageSize = options.maxPageSize || 1000;
        let page = 0;
        let totalRevisions = 0;

        do {
            page++;
            const params = new URLSearchParams({ "api-version": "7.1", $maxPageSize: String(maxPageSize) });
            if (options.startDateTime) params.set("startDateTime", options.startDateTime.toISOString());
            if (continuationToken) params.set("continuationToken", continuationToken);
            const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/reporting/workitemrevisions?${params}`;
            const data = await this.post<ReportingRevisionsResponse>(
                url,
                body,
                "application/json",
                "reporting revisions"
            );
            totalRevisions += data.values.length;
            for (const revision of data.values) {
                if (options.workItemIds && !options.workItemIds.includes(revision.id)) continue;
                if (!revisionsByItem.has(revision.id)) revisionsByItem.set(revision.id, []);
                revisionsByItem.get(revision.id)!.push(revision);
            }
            continuationToken = data.continuationToken;
            options.onProgress?.({ page, matchedItems: revisionsByItem.size, totalRevisions });
        } while (continuationToken);

        return revisionsByItem;
    }

    /**
     * Fetch full revision snapshots for a single work item.
     * @note Not used in main flow because /updates provides oldValue/newValue deltas.
     * @note Could be useful for: Reconstructing exact complete state at each revision.
     */
    async getWorkItemRevisions(
        id: number,
        options?: { top?: number; expand?: string }
    ): Promise<Array<{ rev: number; fields: Record<string, unknown> }>> {
        const params = new URLSearchParams({ "api-version": "7.1" });
        if (options?.top) params.set("$top", String(options.top));
        if (options?.expand) params.set("$expand", options.expand);
        const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workItems/${id}/revisions?${params}`;
        const data = await this.get<{ value: Array<{ rev: number; fields: Record<string, unknown> }> }>(
            url,
            `revisions for #${id}`
        );
        return data.value;
    }

    /**
     * Fetch all team members for fuzzy user resolution.
     * Cached with 30-day TTL.
     */
    async getTeamMembers(): Promise<IdentityRef[]> {
        const cached = await loadTeamMembersCache(this.config.projectId);
        if (cached) return cached;

        const teamsUrl = `${this.config.org}/_apis/projects/${this.config.projectId}/teams?api-version=7.1`;
        const teams = await this.get<{ value: Array<{ id: string; name: string }> }>(teamsUrl, "teams");
        const members: IdentityRef[] = [];
        const seen = new Set<string>();

        for (const team of teams.value) {
            const membersUrl = `${this.config.org}/_apis/projects/${this.config.projectId}/teams/${team.id}/members?api-version=7.1`;
            const data = await this.get<{ value: Array<{ identity: IdentityRef }> }>(
                membersUrl,
                `members of ${team.name}`
            );
            for (const m of data.value) {
                const key = m.identity.uniqueName || m.identity.displayName;
                if (!seen.has(key)) {
                    seen.add(key);
                    members.push(m.identity);
                }
            }
        }

        await saveTeamMembersCache(this.config.projectId, members);
        return members;
    }

    /**
     * Get project ID from organization and project name
     * This is a static method because it doesn't require an existing config instance
     */
    static async getProjectId(org: string, project: string): Promise<string> {
        logger.debug(`[api:static] Fetching project ID for: ${project}`);
        const result =
            await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
        const token = result.text().trim();

        const url = `${org}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`;
        logger.debug(`[api:static] GET ${url.replace(org, "")}`);

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        logger.debug(`[api:static] Response: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            throw new Error(`Failed to get project info: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { id: string };
        logger.debug(`[api:static] Project ID: ${data.id}`);
        return data.id;
    }

    /**
     * Get all projects from an organization
     */
    static async getProjects(org: string): Promise<Array<{ id: string; name: string }>> {
        logger.debug(`[api:static] Fetching all projects from: ${org}`);
        const result =
            await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
        const token = result.text().trim();

        const url = `${org}/_apis/projects?api-version=7.1`;
        logger.debug(`[api:static] GET ${url.replace(org, "")}`);

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        logger.debug(`[api:static] Response: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            throw new Error(`Failed to get projects: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { value: Array<{ id: string; name: string }> };
        logger.debug(`[api:static] Found ${data.value.length} projects`);
        return data.value.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
    }
}
