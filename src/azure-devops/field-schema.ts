/**
 * Azure DevOps CLI - Field schema and used values extraction
 */

import type { UsedValuesCache, WorkItem, WorkItemFull, WorkItemTypeDefinition } from "@app/azure-devops/types";
import { parseRelations } from "./relations";

// Standard Azure DevOps field values (the API doesn't return these in type definition)
const STANDARD_FIELD_VALUES: Record<string, string[]> = {
    "Microsoft.VSTS.Common.Severity": ["A - Critical", "B - High", "C - Medium", "D - Low"],
    "Microsoft.VSTS.Common.Priority": ["1", "2", "3", "4"],
    "Microsoft.VSTS.Common.ValueArea": ["Business", "Architectural"],
    "Microsoft.VSTS.Common.Risk": ["1 - High", "2 - Medium", "3 - Low"],
};

/**
 * Build a simplified field schema from a work item type definition
 * Returns a map of field reference names to their metadata
 */
export function buildFieldSchema(
    typeDef: WorkItemTypeDefinition,
): Map<
    string,
    { name: string; required: boolean; allowedValues?: string[]; defaultValue?: string; helpText?: string }
> {
    const schema = new Map<
        string,
        { name: string; required: boolean; allowedValues?: string[]; defaultValue?: string; helpText?: string }
    >();

    // Use fieldInstances if available, otherwise fields
    const fields = typeDef.fieldInstances || typeDef.fields || [];

    for (const field of fields) {
        // Use API allowedValues if present, otherwise fall back to standard values
        const allowedValues = field.allowedValues || STANDARD_FIELD_VALUES[field.referenceName];

        schema.set(field.referenceName, {
            name: field.name,
            required: field.alwaysRequired || false,
            allowedValues,
            defaultValue: field.defaultValue,
            helpText: field.helpText,
        });
    }

    // Add states as a pseudo-field
    if (typeDef.states && typeDef.states.length > 0) {
        schema.set("System.State", {
            name: "State",
            required: true,
            allowedValues: typeDef.states.map((s) => s.name),
            defaultValue: typeDef.states.find((s) => s.category === "Proposed")?.name,
        });
    }

    return schema;
}

/**
 * Extract commonly used values from a list of work items
 * This provides recommendations based on actual usage patterns
 */
export function extractUsedValues(items: WorkItem[], project: string, queryId?: string): UsedValuesCache {
    const areas = new Set<string>();
    const iterations = new Set<string>();
    const severities = new Set<string>();
    const tagCounts = new Map<string, number>();
    const assignees = new Set<string>();
    const parents = new Map<number, string>(); // id -> title

    for (const item of items) {
        // Note: WorkItem doesn't have areaPath/iterationPath directly
        // These would need to be fetched from full work item details
        // For now, we extract what's available

        if (item.severity) {
            severities.add(item.severity);
        }

        if (item.assignee) {
            assignees.add(item.assignee);
        }

        if (item.tags) {
            for (const tag of item.tags
                .split(";")
                .map((t) => t.trim())
                .filter(Boolean)) {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
        }
    }

    // Sort tags by frequency
    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

    return {
        project,
        queryId,
        fetchedAt: new Date().toISOString(),
        areas: [...areas],
        iterations: [...iterations],
        severities: [...severities],
        tags: sortedTags,
        assignees: [...assignees],
        parents: [...parents.entries()].map(([id, title]) => ({ id, title })),
    };
}

/**
 * Extract used values from full work item details (includes area/iteration paths)
 */
export function extractUsedValuesFromFull(items: WorkItemFull[], project: string, queryId?: string): UsedValuesCache {
    const areas = new Set<string>();
    const iterations = new Set<string>();
    const severities = new Set<string>();
    const tagCounts = new Map<string, number>();
    const assignees = new Set<string>();
    const parents = new Map<number, string>();

    for (const item of items) {
        if (item.severity) {
            severities.add(item.severity);
        }

        if (item.assignee) {
            assignees.add(item.assignee);
        }

        // Extract area and iteration paths from rawFields
        if (item.rawFields) {
            const areaPath = item.rawFields["System.AreaPath"];
            const iterationPath = item.rawFields["System.IterationPath"];

            if (typeof areaPath === "string") {
                areas.add(areaPath);
            }

            if (typeof iterationPath === "string") {
                iterations.add(iterationPath);
            }
        }

        if (item.tags) {
            for (const tag of item.tags
                .split(";")
                .map((t) => t.trim())
                .filter(Boolean)) {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
        }

        // Extract parent from relations
        if (item.relations) {
            const parsed = parseRelations(item.relations);

            if (parsed.parent) {
                parents.set(parsed.parent, `Parent #${parsed.parent}`);
            }
        }
    }

    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

    return {
        project,
        queryId,
        fetchedAt: new Date().toISOString(),
        areas: [...areas],
        iterations: [...iterations],
        severities: [...severities],
        tags: sortedTags,
        assignees: [...assignees],
        parents: [...parents.entries()].map(([id, title]) => ({ id, title })),
    };
}

/**
 * Merge API field definitions with actual usage data to create rich hints
 */
export function mergeFieldsWithUsage(
    fieldSchema: Map<string, { name: string; required: boolean; allowedValues?: string[]; defaultValue?: string }>,
    usedValues: UsedValuesCache,
): Record<
    string,
    {
        description: string;
        required?: boolean;
        allowedValues?: string[];
        usedValues?: string[];
        defaultValue?: string;
        examples?: string[];
    }
> {
    const hints: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    > = {};

    // Standard fields with their commonly used values
    const fieldMappings: Record<string, { usedKey: keyof UsedValuesCache; description: string }> = {
        "System.AreaPath": { usedKey: "areas", description: "Area path for categorization" },
        "System.IterationPath": { usedKey: "iterations", description: "Sprint/Iteration path" },
        "Microsoft.VSTS.Common.Severity": { usedKey: "severities", description: "Severity level" },
        "System.Tags": { usedKey: "tags", description: "Tags for filtering (semicolon-separated)" },
        "System.AssignedTo": { usedKey: "assignees", description: "Assignee email or display name" },
    };

    for (const [refName, schema] of fieldSchema) {
        const mapping = fieldMappings[refName];
        const usedVals = mapping ? (usedValues[mapping.usedKey] as string[]) : undefined;

        hints[refName] = {
            description: mapping?.description || schema.name,
            required: schema.required || undefined,
            allowedValues: schema.allowedValues,
            usedValues: usedVals?.length ? usedVals : undefined,
            defaultValue: schema.defaultValue,
            examples: usedVals?.slice(0, 3),
        };
    }

    return hints;
}
