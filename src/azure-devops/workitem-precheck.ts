/**
 * Work Item Precheck for TimeLog
 *
 * Validates that a work item is of an allowed type before time logging.
 * If the work item type is not allowed (e.g., User Story), it checks children
 * for valid redirect targets (e.g., a single Task child).
 */
import { $ } from "bun";
import logger from "@app/logger";
import type { Relation, AzWorkItemRaw, AllowedTypeConfig } from "@app/azure-devops/types";

// ============= Types =============

export interface ChildInfo {
    id: number;
    type: string;
    title: string;
    state: string;
    assignee: string;
    changedDate: string;
}

export interface PrecheckResult {
    status: "ok" | "redirect" | "error";
    originalId: number;
    originalType: string;
    originalTitle: string;
    redirectId?: number;
    redirectType?: string;
    redirectTitle?: string;
    children?: ChildInfo[];
    message: string;
    suggestCommands?: string[];
}

// ============= Helpers =============

/**
 * Parse child work item IDs from a relations array.
 * Children are linked via "System.LinkTypes.Hierarchy-Forward" relation,
 * with the URL ending in `/<childId>`.
 */
export function parseChildIds(relations: Relation[]): number[] {
    return relations
        .filter((r) => r.rel === "System.LinkTypes.Hierarchy-Forward")
        .map((r) => {
            const match = r.url.match(/\/(\d+)$/);
            return match ? parseInt(match[1], 10) : null;
        })
        .filter((id): id is number => id !== null);
}

/**
 * Fetch a single work item via `az boards work-item show`.
 * Follows the same CLI pattern used in Api.azCommand().
 */
async function fetchWorkItem(id: number, org: string): Promise<AzWorkItemRaw> {
    const command = ["boards", "work-item", "show", "--id", String(id), "--org", org, "-o", "json"];
    logger.debug(`[precheck] Fetching work item #${id}`);

    try {
        const result = await $`az ${command}`.quiet();
        const text = result.text();

        if (!text.trim()) {
            throw new Error(`Empty response for work item #${id}`);
        }

        return JSON.parse(text) as AzWorkItemRaw;
    } catch (error) {
        const stderr = (error as { stderr?: { toString(): string } })?.stderr?.toString?.()?.trim();
        const message = stderr || (error instanceof Error ? error.message : String(error));
        throw new Error(`Failed to fetch work item #${id}: ${message}`);
    }
}

/**
 * Extract typed fields from a raw work item response.
 */
function extractFields(item: AzWorkItemRaw): {
    type: string;
    title: string;
    state: string;
    assignee: string;
    changedDate: string;
} {
    const fields = item.fields ?? {};
    return {
        type: (fields["System.WorkItemType"] as string) ?? "Unknown",
        title: (fields["System.Title"] as string) ?? "",
        state: (fields["System.State"] as string) ?? "",
        assignee: (fields["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName ?? "",
        changedDate: (fields["System.ChangedDate"] as string) ?? "",
    };
}

const DEFAULT_DEPRIORITIZED_STATES = ["Closed", "Done", "Resolved", "Removed"];

/**
 * Select the best child from multiple candidates using 3-tier prioritization:
 *   Tier 1: Active state + assigned to default user
 *   Tier 2: Active state + assigned to anyone
 *   Tier 3: Deprioritized state (Closed/Done/Resolved) — most recently changed first
 */
function selectBestChildren(
    children: ChildInfo[],
    deprioritizedStates: string[],
    defaultUserName?: string
): ChildInfo[] {
    const isDeprioritized = (state: string) =>
        deprioritizedStates.some((ds) => ds.toLowerCase() === state.toLowerCase());

    const isDefaultUser = (assignee: string) => {
        if (!defaultUserName || !assignee) return false;
        const normAssignee = assignee.toLowerCase();
        const normDefault = defaultUserName.toLowerCase();
        return normAssignee.includes(normDefault) || normDefault.includes(normAssignee);
    };

    // Tier 1: Active state + default user
    const tier1 = children.filter((c) => !isDeprioritized(c.state) && isDefaultUser(c.assignee));
    if (tier1.length > 0) return tier1;

    // Tier 2: Active state + anyone
    const tier2 = children.filter((c) => !isDeprioritized(c.state));
    if (tier2.length > 0) return tier2;

    // Tier 3: Deprioritized states — sort by most recently changed
    return [...children].sort((a, b) => b.changedDate.localeCompare(a.changedDate));
}

// ============= Main Precheck =============

/**
 * Validate a work item for time logging.
 *
 * Logic:
 * 1. If allowedWorkItemTypes is not configured, return error with setup suggestion.
 * 2. Fetch the work item by ID.
 * 3. If its type is in allowedWorkItemTypes, return ok.
 * 4. If not, find children of allowed types (optionally filtered by allowed states).
 *    - 0 matches: error with message.
 *    - 1+ matches: prioritize using 3-tier system:
 *        Tier 1: Active state + assigned to default user
 *        Tier 2: Active state + assigned to anyone
 *        Tier 3: Deprioritized state (Closed/Done/Resolved) — most recently changed
 *    - If best tier has exactly 1: redirect to it.
 *    - If best tier has >1: error with children list for user to choose.
 */
export async function precheckWorkItem(
    workItemId: number,
    org: string,
    config: AllowedTypeConfig | undefined
): Promise<PrecheckResult> {
    if (!config?.allowedWorkItemTypes?.length) {
        return {
            status: "error",
            originalId: workItemId,
            originalType: "Unknown",
            originalTitle: "",
            message: "allowedWorkItemTypes not configured. Configure allowed types for time logging.",
            suggestCommands: ["tools azure-devops timelog configure"],
        };
    }

    const item = await fetchWorkItem(workItemId, org);
    const { type, title } = extractFields(item);

    if (config.allowedWorkItemTypes.includes(type)) {
        return {
            status: "ok",
            originalId: workItemId,
            originalType: type,
            originalTitle: title,
            message: `Work item #${workItemId} is a ${type} — allowed for time logging.`,
        };
    }

    // Type not allowed — look for children that are
    const relations = item.relations ?? [];
    const childIds = parseChildIds(relations);

    if (childIds.length === 0) {
        return {
            status: "error",
            originalId: workItemId,
            originalType: type,
            originalTitle: title,
            message: `Work item #${workItemId} is a ${type} which is not allowed for time logging, and it has no children.`,
        };
    }

    logger.debug(`[precheck] Work item #${workItemId} (${type}) has ${childIds.length} children — checking types`);

    const children: ChildInfo[] = [];
    for (const childId of childIds) {
        try {
            const childItem = await fetchWorkItem(childId, org);
            const childFields = extractFields(childItem);

            if (!config.allowedWorkItemTypes.includes(childFields.type)) {
                continue;
            }

            if (config.allowedStatesPerType) {
                const allowedStates = config.allowedStatesPerType[childFields.type];
                if (allowedStates && !allowedStates.includes(childFields.state)) {
                    continue;
                }
            }

            children.push({
                id: childId,
                type: childFields.type,
                title: childFields.title,
                state: childFields.state,
                assignee: childFields.assignee,
                changedDate: childFields.changedDate,
            });
        } catch (error) {
            logger.debug(`[precheck] Failed to fetch child #${childId}: ${error}`);
        }
    }

    if (children.length === 0) {
        return {
            status: "error",
            originalId: workItemId,
            originalType: type,
            originalTitle: title,
            message: `Work item #${workItemId} is a ${type} — no children of allowed types (${config.allowedWorkItemTypes.join(", ")}) found.`,
        };
    }

    // Prioritize children: default user's active > anyone's active > closed/done (most recent)
    const deprioritized = config.deprioritizedStates ?? DEFAULT_DEPRIORITIZED_STATES;
    const best = selectBestChildren(children, deprioritized, config.defaultUserName);

    if (best.length === 1) {
        const child = best[0];
        return {
            status: "redirect",
            originalId: workItemId,
            originalType: type,
            originalTitle: title,
            redirectId: child.id,
            redirectType: child.type,
            redirectTitle: child.title,
            message: `Work item #${workItemId} is a ${type}. Redirecting to child ${child.type} #${child.id} "${child.title}" (${child.state}, ${child.assignee || "unassigned"}).`,
        };
    }

    return {
        status: "error",
        originalId: workItemId,
        originalType: type,
        originalTitle: title,
        children: best,
        message: `Work item #${workItemId} is a ${type} with ${best.length} children of allowed types. Specify one directly.`,
        suggestCommands: best.map((c) => `tools azure-devops timelog add --workitem ${c.id}`),
    };
}
