import { Api } from "../api";
import { saveWorkItemCache } from "../cache";
import type { AzureConfig, WorkItemCache, WorkItemFull } from "../types";
import { WORKITEM_CACHE_VERSION } from "../types";

export interface WorkItemSearchResult {
    id: number;
    title: string;
    type: string;
    state: string;
}

async function cacheWorkItems(workItems: Map<number, WorkItemFull>): Promise<void> {
    const now = new Date().toISOString();

    await Promise.all(
        [...workItems.values()].map((wi) => {
            const entry: WorkItemCache = {
                version: WORKITEM_CACHE_VERSION,
                cache: { fieldsFetchedAt: now },
                id: wi.id,
                rev: wi.rev,
                changed: wi.changed,
                title: wi.title,
                state: wi.state,
            };
            return saveWorkItemCache(wi.id, entry);
        })
    );
}

/**
 * Search work items by query string or ID.
 * If query is a number, searches by exact ID.
 * Otherwise, searches by title among items assigned to @Me.
 */
export async function searchWorkItems(
    config: AzureConfig,
    query: string,
    options?: { top?: number }
): Promise<WorkItemSearchResult[]> {
    const api = new Api(config);
    const top = options?.top ?? 20;

    const wiql = query.match(/^\d+$/)
        ? `SELECT [System.Id] FROM workitems WHERE [System.Id] = ${query}`
        : `SELECT [System.Id] FROM workitems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' AND [System.Title] CONTAINS '${query.replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC`;

    const result = await api.runWiql(wiql, { top });

    if (!result.workItems || result.workItems.length === 0) {
        return [];
    }

    const ids = result.workItems.map((wi) => wi.id);
    const workItemsMap = await api.getWorkItems(ids, { comments: false });

    void cacheWorkItems(workItemsMap);

    return [...workItemsMap.values()].map((wi) => ({
        id: wi.id,
        title: wi.title,
        type: (wi.rawFields?.["System.WorkItemType"] as string) ?? "",
        state: wi.state,
    }));
}

/**
 * Get my assigned (active) work items.
 */
export async function getMyWorkItems(config: AzureConfig, options?: { top?: number }): Promise<WorkItemSearchResult[]> {
    const api = new Api(config);
    const top = options?.top ?? 30;

    const wiql = `SELECT [System.Id] FROM workitems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`;

    const result = await api.runWiql(wiql, { top });

    if (!result.workItems || result.workItems.length === 0) {
        return [];
    }

    const ids = result.workItems.map((wi) => wi.id);
    const workItemsMap = await api.getWorkItems(ids, { comments: false });

    void cacheWorkItems(workItemsMap);

    return [...workItemsMap.values()].map((wi) => ({
        id: wi.id,
        title: wi.title,
        type: (wi.rawFields?.["System.WorkItemType"] as string) ?? "",
        state: wi.state,
    }));
}
