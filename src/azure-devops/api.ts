/**
 * Azure DevOps CLI Tool - API Module
 *
 * This file contains the Api class that encapsulates all Azure DevOps API
 * interactions, including authentication, querying, and data retrieval.
 */

import type {
    CommentsResponse,
    Dashboard,
    DashboardDetailResponse,
    DashboardsListResponse,
    GetWorkItemsOptions,
    QueryNode,
    TeamMembersResponse,
    TeamsListResponse,
} from "@app/azure-devops/api.types";
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
import { concurrentMap } from "@app/utils/async";
import { buildUrl } from "@app/utils/url";
import { $ } from "bun";

// Azure DevOps API resource ID (constant for all Azure DevOps organizations)
export const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

// Re-export Dashboard for backwards compatibility
export type { Dashboard };

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
    static witUrl(
        config: AzureConfig,
        path: string | string[],
        queryParams?: Record<string, string | undefined>
    ): string {
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
    static witUrlPreview(
        config: AzureConfig,
        path: string | string[],
        queryParams?: Record<string, string | undefined>,
        version = "7.1-preview.3"
    ): string {
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
    static projectApiUrl(
        config: AzureConfig,
        path: string[],
        queryParams?: Record<string, string | undefined>,
        apiVersion = "7.1"
    ): string {
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
        if (body !== undefined) {
            const bodyStr = JSON.stringify(body);
            const truncated = bodyStr.length > 500 ? `${bodyStr.slice(0, 500)}... (${bodyStr.length} chars)` : bodyStr;
            logger.debug(`[api] ${method} body: ${truncated}`);
        }
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
     * Download binary content from Azure DevOps (for attachments).
     * Returns ArrayBuffer (caller saves to disk).
     */
    async fetchBinary(url: string, description?: string): Promise<ArrayBuffer> {
        const shortUrl = url.replace(this.config.org, "").slice(0, 80);
        logger.debug(`[api] GET binary ${shortUrl}${description ? ` (${description})` : ""}`);
        const startTime = Date.now();

        const token = await this.getAccessToken();
        const response = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
        });

        const elapsed = Date.now() - startTime;
        logger.debug(`[api] GET binary response: ${response.status} ${response.statusText} (${elapsed}ms)`);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }

        return response.arrayBuffer();
    }

    /**
     * Generate the URL for a work item in Azure DevOps web UI
     */
    generateWorkItemUrl(id: number): string {
        return Api.workItemWebUrl(this.config, id);
    }

    /**
     * Run a saved query and return the work items with full field data
     * Uses REST API to get ChangedDate and other fields not returned by az boards query
     */
    async runQuery(queryId: string): Promise<WorkItem[]> {
        // Step 1: Run the query to get work item IDs
        const queryUrl = Api.witUrl(this.config, ["wiql", queryId]);
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
            const itemsUrl = Api.orgUrl(this.config, ["wit", "workitems"], { ids: idsParam, fields });
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

    // ============= Shared Mappers =============

    /**
     * Map raw Azure DevOps work item fields to domain model.
     * Shared by getWorkItem, getWorkItems, createWorkItem.
     */
    private mapRawToWorkItemBase(raw: AzWorkItemRaw): Omit<WorkItemFull, "comments" | "updates"> {
        const fields = raw.fields ?? {};
        return {
            id: raw.id,
            rev: raw.rev,
            title: fields["System.Title"] as string,
            state: fields["System.State"] as string,
            changed: fields["System.ChangedDate"] as string,
            severity: fields["Microsoft.VSTS.Common.Severity"] as string | undefined,
            assignee: (fields["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName,
            tags: fields["System.Tags"] as string | undefined,
            description: fields["System.Description"] as string | undefined,
            created: fields["System.CreatedDate"] as string | undefined,
            createdBy: (fields["System.CreatedBy"] as { displayName?: string } | undefined)?.displayName,
            changedBy: (fields["System.ChangedBy"] as { displayName?: string } | undefined)?.displayName,
            url: this.generateWorkItemUrl(raw.id),
            relations: raw.relations,
            rawFields: fields,
        };
    }

    private mapComments(data: CommentsResponse): Comment[] {
        return (data.comments || []).map((c) => ({
            id: c.id,
            author: c.createdBy?.displayName,
            date: c.createdDate,
            text: c.text,
        }));
    }

    /**
     * Get full details of a single work item including comments.
     * Delegates to getWorkItems() for consistency.
     */
    async getWorkItem(id: number): Promise<WorkItemFull> {
        const results = await this.getWorkItems([id], { comments: true });
        const item = results.get(id);
        if (!item) throw new Error(`Work item #${id} not found`);
        return item;
    }

    /**
     * Fetch work items by IDs with configurable extra data.
     * Always fetches all fields + relations via $expand=all (batches of 200).
     * Optionally fetches comments and/or updates in parallel.
     */
    async getWorkItems(
        ids: number[],
        options: GetWorkItemsOptions = { comments: true }
    ): Promise<Map<number, WorkItemFull>> {
        const batchSize = 200;

        // Phase 1: Batch fetch fields + relations
        const allBaseItems = new Map<number, Omit<WorkItemFull, "comments" | "updates">>();
        for (let i = 0; i < ids.length; i += batchSize) {
            const batchIds = ids.slice(i, i + batchSize);
            const url = Api.orgUrl(this.config, ["wit", "workitems"], {
                ids: batchIds.join(","),
                $expand: "all",
            });
            const response = await this.get<{ value: AzWorkItemRaw[] }>(
                url,
                `batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(ids.length / batchSize)}`
            );
            for (const item of response.value) {
                allBaseItems.set(item.id, this.mapRawToWorkItemBase(item));
            }
        }

        logger.debug(`[api] Batch fetched ${allBaseItems.size} work items`);

        // Phase 2: Parallel fetch of comments and/or updates
        const fetchComments = options.comments !== false;
        const fetchUpdates = options.updates === true;

        const commentsMap = fetchComments ? await this.fetchComments(ids) : new Map<number, Comment[]>();

        const updatesMap = fetchUpdates ? await this.fetchUpdates(ids) : new Map<number, WorkItemUpdate[]>();

        // Phase 3: Assemble results
        const result = new Map<number, WorkItemFull>();
        for (const id of ids) {
            const base = allBaseItems.get(id);
            if (!base) continue;
            const entry: WorkItemFull = {
                ...base,
                comments: commentsMap.get(id) ?? [],
            };
            if (fetchUpdates) {
                entry.updates = updatesMap.get(id) ?? [];
            }
            result.set(id, entry);
        }

        return result;
    }

    private async fetchComments(ids: number[]): Promise<Map<number, Comment[]>> {
        const result = await concurrentMap({
            items: ids,
            fn: async (id) => {
                const url = Api.witUrlPreview(this.config, ["workItems", String(id), "comments"]);
                const data = await this.get<CommentsResponse>(url, `comments #${id}`);
                return this.mapComments(data);
            },
            onError: (id, error) => logger.warn(`[api] Failed to fetch comments for #${id}: ${error}`),
        });
        logger.debug(`[api] Fetched comments for ${result.size}/${ids.length} items`);
        return result;
    }

    private async fetchUpdates(ids: number[]): Promise<Map<number, WorkItemUpdate[]>> {
        const result = await concurrentMap({
            items: ids,
            fn: async (id) => this.getWorkItemUpdates(id),
            onError: (id, error) => logger.warn(`[api] Failed to fetch updates for #${id}: ${error}`),
        });
        logger.debug(`[api] Fetched updates for ${result.size}/${ids.length} items`);
        return result;
    }

    /**
     * Batch fetch full work items (all fields + relations) in one REST call.
     * Batches of 200 (API limit). Comments NOT included — use batchGetComments().
     */
    async batchGetFullWorkItems(ids: number[]): Promise<Map<number, Omit<WorkItemFull, "comments">>> {
        const result = new Map<number, Omit<WorkItemFull, "comments">>();
        const batchSize = 200;

        for (let i = 0; i < ids.length; i += batchSize) {
            const batchIds = ids.slice(i, i + batchSize);
            const url = Api.orgUrl(this.config, ["wit", "workitems"], {
                ids: batchIds.join(","),
                $expand: "all",
            });
            const response = await this.get<{ value: AzWorkItemRaw[] }>(
                url,
                `batch full ${Math.floor(i / batchSize) + 1}/${Math.ceil(ids.length / batchSize)}`
            );

            for (const item of response.value) {
                const fields = item.fields ?? {};
                result.set(item.id, {
                    id: item.id,
                    rev: item.rev,
                    title: fields["System.Title"] as string,
                    state: fields["System.State"] as string,
                    changed: fields["System.ChangedDate"] as string,
                    severity: fields["Microsoft.VSTS.Common.Severity"] as string | undefined,
                    assignee: (fields["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName,
                    tags: fields["System.Tags"] as string | undefined,
                    description: fields["System.Description"] as string | undefined,
                    created: fields["System.CreatedDate"] as string | undefined,
                    createdBy: (fields["System.CreatedBy"] as { displayName?: string } | undefined)?.displayName,
                    changedBy: (fields["System.ChangedBy"] as { displayName?: string } | undefined)?.displayName,
                    url: this.generateWorkItemUrl(item.id),
                    relations: item.relations,
                    rawFields: fields,
                });
            }
        }

        logger.debug(`[api] Batch fetched ${result.size} full work items`);
        return result;
    }

    /**
     * Fetch comments for multiple work items in parallel with concurrency limit.
     */
    async batchGetComments(ids: number[], concurrency = 5): Promise<Map<number, Comment[]>> {
        const result = new Map<number, Comment[]>();

        for (let i = 0; i < ids.length; i += concurrency) {
            const batch = ids.slice(i, i + concurrency);
            const promises = batch.map(async (id) => {
                const commentsUrl = Api.witUrlPreview(this.config, ["workItems", String(id), "comments"]);
                const commentsData = await this.get<{
                    comments: Array<{
                        id: number;
                        createdBy: { displayName: string };
                        createdDate: string;
                        text: string;
                    }>;
                }>(commentsUrl, `comments for #${id}`);

                const comments: Comment[] = (commentsData.comments || []).map((c) => ({
                    id: c.id,
                    author: c.createdBy?.displayName,
                    date: c.createdDate,
                    text: c.text,
                }));
                return { id, comments };
            });

            const results = await Promise.all(promises);
            for (const { id, comments } of results) {
                result.set(id, comments);
                logger.debug(`[api] Work item #${id} has ${comments.length} comments`);
            }
        }

        logger.debug(`[api] Batch fetched comments for ${result.size} work items`);
        return result;
    }

    /**
     * Get dashboard information including all queries it contains
     */
    async getDashboard(dashboardId: string): Promise<Dashboard> {
        logger.debug(`[api] Fetching dashboard ${dashboardId.slice(0, 8)}...`);
        const dashboardsUrl = Api.projectApiUrl(this.config, ["dashboard", "dashboards"], undefined, "7.1-preview.3");
        const dashboardsData = await this.get<DashboardsListResponse>(dashboardsUrl, "list dashboards");

        const dashboard = dashboardsData.value.find((d) => d.id === dashboardId);
        if (!dashboard) {
            throw new Error(`Dashboard ${dashboardId} not found`);
        }
        logger.debug(`[api] Found dashboard: "${dashboard.name}"`);

        const groupPath = dashboard.groupId ? `${this.config.projectId}/${dashboard.groupId}` : this.config.projectId;
        const widgetsUrl = buildUrl({
            base: this.config.org,
            segments: [groupPath, "_apis", "Dashboard", "Dashboards", dashboardId],
            queryParams: { "api-version": "7.1-preview.3" },
        });
        const widgetsData = await this.get<DashboardDetailResponse>(widgetsUrl, "dashboard widgets");
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
        const url = Api.witUrl(this.config, ["workitems", `$${encodeURIComponent(type)}`]);

        const result = await this.post<Record<string, unknown>>(
            url,
            operations,
            "application/json-patch+json",
            `create ${type}`
        );
        logger.debug(`[api] Created work item #${result.id}`);

        return {
            ...this.mapRawToWorkItemBase(result as unknown as AzWorkItemRaw),
            comments: [],
        };
    }

    /**
     * Get the definition of a work item type including fields, states, and transitions
     */
    async getWorkItemTypeDefinition(type: WorkItemType): Promise<WorkItemTypeDefinition> {
        logger.debug(`[api] Fetching type definition for: ${type}`);
        const url = Api.witUrl(this.config, ["workitemtypes", encodeURIComponent(type)]);
        return this.get<WorkItemTypeDefinition>(url, `type definition: ${type}`);
    }

    /**
     * Get list of available (non-disabled) work item types in the project
     */
    async getAvailableWorkItemTypes(): Promise<WorkItemType[]> {
        logger.debug("[api] Fetching available work item types");
        const url = Api.witUrl(this.config, "workitemtypes");
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
        const rootUrl = Api.witUrl(this.config, "queries", { $depth: "2" });
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
                    const childUrl = Api.witUrl(this.config, ["queries", node.id], { $depth: "2" });
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
        const url = Api.witUrl(this.config, "wiql", { $top: options?.top ? String(options.top) : undefined });
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
            const url = Api.witUrl(this.config, ["workItems", String(id), "updates"], {
                $top: String(top),
                $skip: String(skip),
            });
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
            const url = Api.witUrl(this.config, ["reporting", "workitemrevisions"], {
                $maxPageSize: String(maxPageSize),
                startDateTime: options.startDateTime?.toISOString(),
                continuationToken,
            });
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
                revisionsByItem.get(revision.id)?.push(revision);
            }
            continuationToken = data.continuationToken;
            options.onProgress?.({ page, matchedItems: revisionsByItem.size, totalRevisions });

            // Azure DevOps sometimes returns continuation tokens on final/empty pages.
            // Stop if: explicit last batch flag, empty page, or no continuation token.
            if (data.isLastBatch || data.values.length === 0) {
                logger.debug(
                    `[api] Reporting API: stopping pagination (isLastBatch=${data.isLastBatch}, pageSize=${data.values.length})`
                );
                break;
            }
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
        const url = Api.witUrl(this.config, ["workItems", String(id), "revisions"], {
            $top: options?.top ? String(options.top) : undefined,
            $expand: options?.expand,
        });
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

        const teamsUrl = Api.orgUrl(this.config, ["projects", this.config.projectId, "teams"]);
        const teams = await this.get<TeamsListResponse>(teamsUrl, "teams");
        const members: IdentityRef[] = [];
        const seen = new Set<string>();

        for (const team of teams.value) {
            const membersUrl = Api.orgUrl(this.config, [
                "projects",
                this.config.projectId,
                "teams",
                team.id,
                "members",
            ]);
            const data = await this.get<TeamMembersResponse>(membersUrl, `members of ${team.name}`);
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

        const url = Api.orgUrlRaw(org, ["projects", encodeURIComponent(project)]);
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

        const url = Api.orgUrlRaw(org, ["projects"]);
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
