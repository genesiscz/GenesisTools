/**
 * Azure DevOps CLI Tool - API Module
 *
 * This file contains the Api class that encapsulates all Azure DevOps API
 * interactions, including authentication, querying, and data retrieval.
 */

import { $ } from "bun";
import logger from "@app/logger";
import type {
  AzureConfig,
  AzWorkItemRaw,
  WorkItem,
  WorkItemFull,
  Comment,
  WorkItemType,
  WorkItemTypeDefinition,
  JsonPatchOperation,
  QueryInfo,
} from "@app/azure-devops/types";

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
      const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
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
  private async post<T>(url: string, body: unknown, contentType = "application/json", description?: string): Promise<T> {
    return this.request<T>("POST", url, { body, contentType, description });
  }

  /**
   * Generate the URL for a work item in Azure DevOps web UI
   */
  generateWorkItemUrl(id: number): string {
    return `${this.config.org}/${encodeURIComponent(this.config.project)}/_workitems/edit/${id}`;
  }

  /**
   * Run a saved query and return the work items
   */
  async runQuery(queryId: string): Promise<WorkItem[]> {
    const items = await this.azCommand<unknown[]>(
      ["boards", "query", "--id", queryId, "-o", "json"],
      `Running query ${queryId.slice(0, 8)}...`
    );

    if (!Array.isArray(items)) {
      throw new Error("Expected array from az boards query");
    }
    logger.debug(`[api] Query returned ${items.length} work items`);

    return items.map((item) => {
      const record = item as Record<string, unknown>;
      const fields = record.fields as Record<string, unknown>;
      const id = record.id as number;
      return {
        id,
        rev: record.rev as number,
        title: fields?.["System.Title"] as string,
        state: fields?.["System.State"] as string,
        changed: fields?.["System.ChangedDate"] as string,
        severity: fields?.["Microsoft.VSTS.Common.Severity"] as string | undefined,
        assignee: (fields?.["System.AssignedTo"] as Record<string, unknown>)?.displayName as string | undefined,
        tags: fields?.["System.Tags"] as string | undefined,
        created: fields?.["System.CreatedDate"] as string | undefined,
        createdBy: (fields?.["System.CreatedBy"] as Record<string, unknown>)?.displayName as string | undefined,
        changedBy: (fields?.["System.ChangedBy"] as Record<string, unknown>)?.displayName as string | undefined,
        url: this.generateWorkItemUrl(id),
      };
    });
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
    const commentsData = await this.get<{ comments: Array<{ id: number; createdBy: { displayName: string }; createdDate: string; text: string }> }>(commentsUrl, `comments for #${id}`);
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
      comments: (commentsData.comments || []).map((c): Comment => ({
        id: c.id,
        author: c.createdBy?.displayName,
        date: c.createdDate,
        text: c.text,
      })),
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
    const dashboardsData = await this.get<{ value: Array<{ id: string; name: string; groupId?: string }> }>(dashboardsUrl, "list dashboards");

    const dashboard = dashboardsData.value.find(d => d.id === dashboardId);
    if (!dashboard) {
      throw new Error(`Dashboard ${dashboardId} not found`);
    }
    logger.debug(`[api] Found dashboard: "${dashboard.name}"`);

    const groupPath = dashboard.groupId ? `${this.config.projectId}/${dashboard.groupId}` : this.config.projectId;
    const widgetsUrl = `${this.config.org}/${groupPath}/_apis/Dashboard/Dashboards/${dashboardId}?api-version=7.1-preview.3`;
    const widgetsData = await this.get<{ name: string; widgets: Array<{ name: string; settings: string }> }>(widgetsUrl, "dashboard widgets");
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
    logger.debug(`[api] Operations: ${operations.map(o => o.path).join(", ")}`);
    const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`;

    const result = await this.post<Record<string, unknown>>(url, operations, "application/json-patch+json", `create ${type}`);
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
    const types = result.value.filter(t => !t.isDisabled).map(t => t.name as WorkItemType);
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

  /**
   * Get project ID from organization and project name
   * This is a static method because it doesn't require an existing config instance
   */
  static async getProjectId(org: string, project: string): Promise<string> {
    logger.debug(`[api:static] Fetching project ID for: ${project}`);
    const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
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

    const data = await response.json() as { id: string };
    logger.debug(`[api:static] Project ID: ${data.id}`);
    return data.id;
  }

  /**
   * Get all projects from an organization
   */
  static async getProjects(org: string): Promise<Array<{ id: string; name: string }>> {
    logger.debug(`[api:static] Fetching all projects from: ${org}`);
    const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
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

    const data = await response.json() as { value: Array<{ id: string; name: string }> };
    logger.debug(`[api:static] Found ${data.value.length} projects`);
    return data.value.map(p => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
