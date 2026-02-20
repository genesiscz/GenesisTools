/**
 * Azure DevOps CLI - Template generation and management
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkItem, WorkItemFull, WorkItemTemplate, WorkItemType } from "@app/azure-devops/types";
import { htmlToMarkdown } from "@app/utils/markdown/html-to-md";
import { extractUsedValues } from "./field-schema";
import { parseRelations } from "./relations";

/**
 * Transform API hints to template hint format
 */
function transformHintsForTemplate(
    hints: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    >
): WorkItemTemplate["_hints"] {
    const templateHints: WorkItemTemplate["_hints"] = {};

    // Map API field names to simple field names
    const fieldMapping: Record<string, string> = {
        "System.Title": "title",
        "System.Description": "description",
        "Microsoft.VSTS.Common.Severity": "severity",
        "System.AreaPath": "areaPath",
        "System.IterationPath": "iterationPath",
        "System.Tags": "tags",
        "System.AssignedTo": "assignedTo",
        "System.State": "state",
    };

    for (const [refName, hint] of Object.entries(hints)) {
        const simpleKey = fieldMapping[refName] || refName;
        templateHints[simpleKey] = hint;
    }

    // Always add title hint
    if (!templateHints.title) {
        templateHints.title = {
            description: "Brief title for the work item",
            required: true,
        };
    }

    return templateHints;
}

/**
 * Generate an empty work item template for a given type
 */
export function generateEmptyTemplate(
    type: WorkItemType,
    hints?: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    >
): WorkItemTemplate {
    return {
        $schema: "azure-devops-workitem-v1",
        type,
        fields: {
            title: "",
            description: "",
            severity: "",
            areaPath: "",
            iterationPath: "",
            tags: [],
            assignedTo: "",
        },
        relations: {
            parent: undefined,
            children: [],
            related: [],
        },
        _hints: hints ? transformHintsForTemplate(hints) : undefined,
        _source: {
            generatedAt: new Date().toISOString(),
        },
    };
}

/**
 * Infer work item type from title patterns
 */
function inferWorkItemType(title: string): WorkItemType | undefined {
    const lower = title.toLowerCase();

    if (lower.includes("bug") || lower.includes("fix") || lower.includes("error")) return "Bug";

    if (lower.includes("feature") || lower.includes("implement")) return "Feature";

    if (lower.includes("task")) return "Task";

    if (lower.includes("story") || lower.includes("user")) return "User Story";
    return undefined;
}

/**
 * Extract a description template from existing description
 * Preserves section structure but clears content
 */
function extractDescriptionTemplate(description?: string): string {
    if (!description) return "";

    // Convert HTML to markdown first
    const md = htmlToMarkdown(description);

    // Find section headers and preserve structure
    const lines = md.split("\n");
    const template: string[] = [];

    for (const line of lines) {
        if (line.startsWith("##") || line.startsWith("###")) {
            template.push(line);
            template.push("");
        }
    }

    // If no sections found, return empty string
    // (The API's helpText provides the appropriate template for new work items)
    if (template.length === 0) {
        return "";
    }

    return template.join("\n");
}

/**
 * Extract a display value from a raw Azure DevOps field value
 * Handles objects with displayName (users), strings, numbers, etc.
 */
function extractFieldValue(value: unknown): string | number | string[] | undefined {
    if (value === null || value === undefined) return undefined;

    // Handle user/identity objects (have displayName)
    if (typeof value === "object" && value !== null && "displayName" in value) {
        return (value as { displayName: string }).displayName;
    }

    // Handle arrays
    if (Array.isArray(value)) {
        return value.map((v) => String(v));
    }

    // Handle primitives
    if (typeof value === "string") return value;

    if (typeof value === "number") return value;

    return String(value);
}

/** Check if a string looks like a GUID */
function isGuid(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Generate a template pre-filled with values from an existing work item
 * Useful for creating similar work items
 *
 * Uses rawFields to extract ALL fields from the source item, including custom fields.
 * @param sourceItem - The work item to use as template
 * @param type - Optional work item type override
 * @param fieldSchema - Optional field schema from type definition (for allowedValues)
 */
export function generateTemplateFromWorkItem(
    sourceItem: WorkItemFull,
    type?: WorkItemType,
    fieldSchema?: Map<
        string,
        { name: string; required: boolean; allowedValues?: string[]; helpText?: string; defaultValue?: string }
    >
): WorkItemTemplate {
    const parsed = sourceItem.relations
        ? parseRelations(sourceItem.relations)
        : { parent: undefined, children: [], related: [] };
    const rawFields = sourceItem.rawFields || {};

    // Extract all field values from raw API response
    const fields: Record<string, unknown> = {
        title: "", // Empty - user should provide new title
        description: extractDescriptionTemplate(sourceItem.description),
    };

    // Known field mappings (Azure DevOps reference name -> template field name)
    const fieldMappings: Record<string, string> = {
        "System.AreaPath": "areaPath",
        "System.IterationPath": "iterationPath",
        "System.AssignedTo": "assignedTo",
        "System.Tags": "tags",
        "Microsoft.VSTS.Common.Severity": "severity",
        "Microsoft.VSTS.Common.Priority": "priority",
        "Microsoft.VSTS.Common.Activity": "activity",
        "Microsoft.VSTS.Scheduling.Effort": "effort",
        "Microsoft.VSTS.Scheduling.RemainingWork": "remainingWork",
        "Microsoft.VSTS.Scheduling.OriginalEstimate": "originalEstimate",
        "Microsoft.VSTS.Common.ValueArea": "valueArea",
        "Microsoft.VSTS.Common.Risk": "risk",
        "Microsoft.VSTS.Common.BusinessValue": "businessValue",
    };

    // Fields to skip (system/computed fields)
    const skipFields = new Set([
        "System.Title", // We set this to empty explicitly
        "System.Description", // We process this specially
        "System.Id",
        "System.Rev",
        "System.WorkItemType",
        "System.State",
        "System.Reason",
        "System.CreatedDate",
        "System.CreatedBy",
        "System.ChangedDate",
        "System.ChangedBy",
        "System.CommentCount",
        "System.TeamProject",
        "System.NodeName",
        "System.AreaId",
        "System.IterationId",
        "System.AreaLevel1",
        "System.AreaLevel2",
        "System.AreaLevel3",
        "System.IterationLevel1",
        "System.IterationLevel2",
        "System.IterationLevel3",
        "System.AuthorizedDate",
        "System.AuthorizedAs",
        "System.RevisedDate",
        "System.Watermark",
        "System.BoardColumn",
        "System.BoardColumnDone",
        "System.BoardLane",
        "System.Parent",
        "System.History", // Comment history
        "System.PersonId",
        "Microsoft.VSTS.Common.StateChangeDate", // Computed
    ]);

    // Hints for extracted fields
    const hints: Record<
        string,
        { description: string; required?: boolean; usedValues?: string[]; allowedValues?: string[] }
    > = {
        title: {
            description: "Title for the new work item",
            required: true,
        },
        description: {
            description: "Description template extracted from source work item",
        },
    };

    // Process all raw fields
    for (const [refName, rawValue] of Object.entries(rawFields)) {
        if (skipFields.has(refName)) continue;

        // Skip GUID-named custom fields (e.g., "Custom.32af3eb0-3fc8-4099-...")
        const parts = refName.split(".");
        const lastPart = parts[parts.length - 1];

        if (isGuid(lastPart)) continue;

        const value = extractFieldValue(rawValue);

        if (value === undefined || value === "") continue;

        // Map to known field name or use last part of reference name
        let fieldName = fieldMappings[refName];

        if (!fieldName) {
            // Extract custom field name: "Custom.Application" -> "application"
            fieldName = lastPart;
            // Convert to camelCase
            fieldName = fieldName.charAt(0).toLowerCase() + fieldName.slice(1);
        }

        // Handle tags specially (split into array)
        if (refName === "System.Tags" && typeof value === "string") {
            fields[fieldName] = value
                .split(";")
                .map((t) => t.trim())
                .filter(Boolean);
        } else {
            fields[fieldName] = value;
        }

        // Add hint for this field
        const valueStr = Array.isArray(value) ? value.join(", ") : String(value);
        const schemaField = fieldSchema?.get(refName);
        hints[fieldName] = {
            description: schemaField?.helpText || `Pre-filled from source work item (${refName})`,
            usedValues: [valueStr],
            allowedValues: schemaField?.allowedValues,
            required: schemaField?.required,
        };
    }

    // Add hints for fields that have allowedValues but weren't in the source item
    if (fieldSchema) {
        for (const [refName, schemaField] of fieldSchema) {
            if (skipFields.has(refName)) continue;

            if (schemaField.allowedValues && schemaField.allowedValues.length > 0) {
                const lastPart = refName.split(".").pop();

                if (!lastPart) continue;
                const fieldName = fieldMappings[refName] || lastPart.charAt(0).toLowerCase() + lastPart.slice(1);

                if (!hints[fieldName]) {
                    hints[fieldName] = {
                        description: schemaField.helpText || `Field from type definition (${refName})`,
                        allowedValues: schemaField.allowedValues,
                        required: schemaField.required,
                    };
                }
            }
        }
    }

    // Ensure parent hint is set
    if (parsed.parent) {
        hints.parent = {
            description: "Same parent as source work item",
            usedValues: [`${parsed.parent}`],
        };
    }

    return {
        $schema: "azure-devops-workitem-v1",
        type: type || inferWorkItemType(sourceItem.title) || "Task",
        fields,
        relations: {
            parent: parsed.parent,
            children: [],
            related: [],
        },
        _hints: hints,
        _source: {
            workItemId: sourceItem.id,
            generatedAt: new Date().toISOString(),
        },
    };
}

/**
 * Generate a template based on patterns from query results
 */
export function generateTemplateFromQuery(
    items: WorkItem[],
    type: WorkItemType,
    project: string,
    queryId: string,
    hints?: Record<
        string,
        {
            description: string;
            required?: boolean;
            allowedValues?: string[];
            usedValues?: string[];
            defaultValue?: string;
            examples?: string[];
        }
    >
): WorkItemTemplate {
    const usedValues = extractUsedValues(items, project, queryId);

    return {
        $schema: "azure-devops-workitem-v1",
        type,
        fields: {
            title: "",
            description: "",
            severity: usedValues.severities[0] || "",
            areaPath: usedValues.areas[0] || "",
            iterationPath: usedValues.iterations[0] || "",
            tags: [],
            assignedTo: "",
        },
        relations: {
            parent: usedValues.parents[0]?.id,
            children: [],
            related: [],
        },
        _hints: {
            title: { description: "Brief title for the work item", required: true },
            severity: {
                description: "Severity level (from query data)",
                allowedValues: hints?.["Microsoft.VSTS.Common.Severity"]?.allowedValues,
                usedValues: usedValues.severities,
                examples: usedValues.severities.slice(0, 2),
            },
            areaPath: {
                description: "Area path for categorization",
                usedValues: usedValues.areas,
            },
            iterationPath: {
                description: "Sprint/Iteration",
                usedValues: usedValues.iterations,
            },
            tags: {
                description: "Tags for filtering",
                usedValues: usedValues.tags,
                examples: usedValues.tags.slice(0, 3),
            },
            assignedTo: {
                description: "Assignee email",
                usedValues: usedValues.assignees,
            },
            parent: {
                description: "Parent work item ID",
                examples: usedValues.parents.slice(0, 2).map((p) => `${p.id} (${p.title})`),
            },
        },
        _source: {
            queryId,
            analyzedItemCount: items.length,
            generatedAt: new Date().toISOString(),
        },
    };
}

/**
 * Save a template to the created templates directory
 * Returns the file path
 */
export function saveTemplate(template: WorkItemTemplate, baseDir?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${timestamp}-New${template.type.replace(/\s+/g, "")}.json`;

    const dir = baseDir || join(process.cwd(), ".claude/azure/tasks/created");

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(template, null, 2));

    return filePath;
}
