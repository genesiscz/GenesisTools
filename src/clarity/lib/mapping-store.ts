import type { ClarityConfig, ClarityMapping } from "@app/clarity/config";
import { saveConfig } from "@app/clarity/config";
import {
    type AssignmentPair,
    applyAssignments,
    type MappingTask,
    removeAssignments,
} from "@app/clarity/lib/assignments";

/**
 * The one writer of the ADO work item to Clarity task mapping table. Each door loads the config
 * itself, because they word "not configured" differently, and hands it in.
 */
export class MappingStore {
    constructor(private readonly options: { onChange?: () => void } = {}) {}

    /** Add or replace mappings. A pair without a title or type keeps the stored one. */
    async upsert(config: ClarityConfig, pairs: AssignmentPair[]): Promise<void> {
        await this.save(config, applyAssignments({ mappings: config.mappings, pairs }));
    }

    /** Point an existing mapping at another task, keeping its title and type. */
    async move(config: ClarityConfig, workItemId: number, task: MappingTask): Promise<void> {
        if (!config.mappings.some((mapping) => mapping.adoWorkItemId === workItemId)) {
            throw new Error(`Mapping for work item ${workItemId} not found`);
        }

        await this.upsert(config, [{ workItemId, task }]);
    }

    /** Remove the mappings for these work items and return the ones that were dropped. */
    async remove(config: ClarityConfig, workItemIds: number[]): Promise<ClarityMapping[]> {
        const { mappings, removed } = removeAssignments({ mappings: config.mappings, workItemIds });
        await this.save(config, mappings);

        return removed;
    }

    private async save(config: ClarityConfig, mappings: ClarityMapping[]): Promise<void> {
        config.mappings = mappings;
        await saveConfig(config);
        this.options.onChange?.();
    }
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid mapping payload: '${field}' must be a non-empty string`);
    }

    return value;
}

function requireNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
        throw new Error(`Invalid mapping payload: '${field}' must be a number`);
    }

    return value;
}

/**
 * Work items Azure DevOps could not describe are listed as `#<id>` (the timelog export) or
 * `Work Item #<id>` (getTimelogWorkItems). Such a title says nothing, so a stored one must win.
 */
function knownTitle(workItemId: number, title: string): string | undefined {
    return title === `#${workItemId}` || title === `Work Item #${workItemId}` ? undefined : title;
}

/** A mapping write from an untrusted payload, such as a dashboard request body. */
export function parseMappingPayload(data: Record<string, unknown>): AssignmentPair {
    const task: MappingTask = {
        taskId: requireNumber(data.clarityTaskId, "clarityTaskId"),
        taskName: requireString(data.clarityTaskName, "clarityTaskName"),
        taskCode: requireString(data.clarityTaskCode, "clarityTaskCode"),
        investmentName: requireString(data.clarityInvestmentName, "clarityInvestmentName"),
        investmentCode: requireString(data.clarityInvestmentCode, "clarityInvestmentCode"),
    };
    const workItemId = requireNumber(data.adoWorkItemId, "adoWorkItemId");
    const title = requireString(data.adoWorkItemTitle, "adoWorkItemTitle");

    return {
        workItemId,
        task,
        title: knownTitle(workItemId, title),
        type:
            typeof data.adoWorkItemType === "string" && data.adoWorkItemType !== "" ? data.adoWorkItemType : undefined,
    };
}
