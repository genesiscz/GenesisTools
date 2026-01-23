/**
 * Azure DevOps CLI Tool - API Module
 *
 * This file contains the Api class that encapsulates all Azure DevOps API
 * interactions, including authentication, querying, and data retrieval.
 */

import { $ } from "bun";
import type {
  AzureConfig,
  WorkItem,
  WorkItemFull,
  Comment,
  WorkItemType,
  WorkItemTypeDefinition,
  JsonPatchOperation,
} from "./types";

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

  constructor(config: AzureConfig) {
    this.config = config;
  }

  /**
   * Get an access token for Azure DevOps API using Azure CLI
   */
  private async getAccessToken(): Promise<string> {
    try {
      const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
      const token = result.text().trim();
      if (!token) {
        throw new Error("Empty token received. Ensure you're logged in with 'az login'");
      }
      return token;
    } catch (error) {
      throw new Error(`Failed to get Azure access token for ${AZURE_DEVOPS_RESOURCE_ID}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Make a GET request to the Azure DevOps API with Bearer token authentication
   */
  private async get<T>(url: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Make a POST request to the Azure DevOps API with Bearer token authentication
   */
  private async post<T>(url: string, body: unknown, contentType = "application/json"): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }
    return response.json();
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
    let items: unknown[];
    try {
      const result = await $`az boards query --id ${queryId} -o json`.quiet();
      const text = result.text();
      if (!text.trim()) {
        throw new Error("Empty response from az boards query");
      }
      items = JSON.parse(text);
      if (!Array.isArray(items)) {
        throw new Error("Expected array from az boards query");
      }
    } catch (error) {
      throw new Error(`Failed to run query ${queryId}: ${error instanceof Error ? error.message : String(error)}`);
    }

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
    const result = await $`az boards work-item show --id ${id} -o json`.quiet();
    const item = JSON.parse(result.text());

    // Get comments
    const commentsUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`;
    const commentsData = await this.get<{ comments: Array<{ id: number; createdBy: { displayName: string }; createdDate: string; text: string }> }>(commentsUrl);

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
      url: this.generateWorkItemUrl(id),
      comments: (commentsData.comments || []).map((c): Comment => ({
        id: c.id,
        author: c.createdBy?.displayName,
        date: c.createdDate,
        text: c.text,
      })),
      relations: item.relations,
      rawFields: item.fields as Record<string, unknown>,
    };
  }

  /**
   * Get dashboard information including all queries it contains
   */
  async getDashboard(dashboardId: string): Promise<Dashboard> {
    const dashboardsUrl = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/dashboard/dashboards?api-version=7.1-preview.3`;
    const dashboardsData = await this.get<{ value: Array<{ id: string; name: string; groupId?: string }> }>(dashboardsUrl);

    const dashboard = dashboardsData.value.find(d => d.id === dashboardId);
    if (!dashboard) {
      throw new Error(`Dashboard ${dashboardId} not found`);
    }

    const groupPath = dashboard.groupId ? `${this.config.projectId}/${dashboard.groupId}` : this.config.projectId;
    const widgetsUrl = `${this.config.org}/${groupPath}/_apis/Dashboard/Dashboards/${dashboardId}?api-version=7.1-preview.3`;
    const widgetsData = await this.get<{ name: string; widgets: Array<{ name: string; settings: string }> }>(widgetsUrl);

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
    const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`;

    const result = await this.post<Record<string, unknown>>(url, operations, "application/json-patch+json");

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
    const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}?api-version=7.1`;
    return this.get<WorkItemTypeDefinition>(url);
  }

  /**
   * Get list of available (non-disabled) work item types in the project
   */
  async getAvailableWorkItemTypes(): Promise<WorkItemType[]> {
    const url = `${this.config.org}/${encodeURIComponent(this.config.project)}/_apis/wit/workitemtypes?api-version=7.1`;
    const result = await this.get<{ value: WorkItemTypeDefinition[] }>(url);
    return result.value
      .filter(t => !t.isDisabled)
      .map(t => t.name as WorkItemType);
  }

  /**
   * Get project ID from organization and project name
   * This is a static method because it doesn't require an existing config instance
   */
  static async getProjectId(org: string, project: string): Promise<string> {
    const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
    const token = result.text().trim();

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

  /**
   * Get all projects from an organization
   */
  static async getProjects(org: string): Promise<Array<{ id: string; name: string }>> {
    const result = await $`az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken -o tsv`.quiet();
    const token = result.text().trim();

    const url = `${org}/_apis/projects?api-version=7.1`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to get projects: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { value: Array<{ id: string; name: string }> };
    return data.value.map(p => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
