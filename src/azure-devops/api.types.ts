/**
 * Azure DevOps API Response Types
 *
 * This file contains type definitions for raw API responses from Azure DevOps.
 * These types represent the exact structure returned by the API endpoints,
 * before transformation into domain types.
 */

import type { IdentityRef } from "@app/azure-devops/types";

/** Raw response from WIQL query execution */
export interface WiqlQueryResponse {
    workItems?: Array<{ id: number; url: string }>;
}

/** Raw response from work item comments endpoint */
export interface CommentsResponse {
    comments: Array<{
        id: number;
        createdBy: { displayName: string };
        createdDate: string;
        text: string;
    }>;
}

/** Raw response from dashboards list */
export interface DashboardsListResponse {
    value: Array<{ id: string; name: string; groupId?: string }>;
}

/** Raw response from dashboard detail (with widgets) */
export interface DashboardDetailResponse {
    name: string;
    widgets: Array<{ name: string; settings: string }>;
}

/** Raw response from teams list */
export interface TeamsListResponse {
    value: Array<{ id: string; name: string }>;
}

/** One iteration (sprint) as returned by `work/teamsettings/iterations` */
export interface TeamIteration {
    id: string;
    name: string;
    path: string;
    attributes?: {
        startDate?: string | null;
        finishDate?: string | null;
        /** Azure's own classification: "past" | "current" | "future" */
        timeFrame?: string;
    };
}

/** Raw response from the team iterations endpoint */
export interface TeamIterationsResponse {
    count: number;
    value: TeamIteration[];
}

/** Raw response from team members */
export interface TeamMembersResponse {
    value: Array<{ identity: IdentityRef }>;
}

/** Raw response from projects list */
export interface ProjectsListResponse {
    value: Array<{ id: string; name: string }>;
}

/** Raw response from project detail */
export interface ProjectDetailResponse {
    id: string;
}

/** Dashboard info (domain type, constructed from API calls) */
export interface Dashboard {
    name: string;
    queries: Array<{ name: string; queryId: string }>;
}

/** Options for getWorkItems — controls which extra data to fetch */
export interface GetWorkItemsOptions {
    /** Fetch comments for each item (parallel, concurrency=5). Default: true */
    comments?: boolean;
    /** Fetch field change updates/history for each item (parallel). Default: false */
    updates?: boolean;
}

/** Query tree node from Queries API (internal to recursive traversal) */
export interface QueryNode {
    id: string;
    name: string;
    path: string;
    isFolder: boolean;
    hasChildren?: boolean;
    children?: QueryNode[];
}

/**
 * One node of the project's iteration classification tree, as returned by
 * `wit/classificationnodes/iterations`. Only leaf-ish nodes carry dates.
 */
export interface IterationClassificationNode {
    id: number;
    identifier: string;
    name: string;
    /** Structural path, e.g. `\Widgets\Iteration\Sprint 17` (note the `Iteration` segment). */
    path: string;
    structureType?: string;
    hasChildren?: boolean;
    attributes?: {
        startDate?: string | null;
        finishDate?: string | null;
    };
    children?: IterationClassificationNode[];
}
