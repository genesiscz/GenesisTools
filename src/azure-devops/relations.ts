/**
 * Azure DevOps CLI - Work item relation and attachment utilities
 */

import type { AttachmentFilter, AttachmentInfo, ParsedRelations, Relation } from "@app/azure-devops/types";

export function parseRelations(relations: Relation[]): ParsedRelations {
    const result: ParsedRelations = { children: [], related: [], other: [] };

    for (const rel of relations) {
        const idMatch = rel.url.match(/workItems\/(\d+)/i);

        if (!idMatch) {
            if (rel.rel !== "AttachedFile") {
                result.other.push(rel.rel);
            }

            continue;
        }

        const id = parseInt(idMatch[1], 10);

        if (rel.rel === "System.LinkTypes.Hierarchy-Reverse") {
            result.parent = id;
        } else if (rel.rel === "System.LinkTypes.Hierarchy-Forward") {
            result.children.push(id);
        } else if (rel.rel.includes("Related")) {
            result.related.push(id);
        } else {
            result.related.push(id);
        }
    }

    return result;
}

// ============= Attachment Utilities =============

function extractAttachmentId(url: string): string {
    const match = url.match(/\/attachments\/([a-f0-9-]+)/i);
    return match?.[1] ?? "";
}

/** Extract typed attachment info from work item relations */
export function parseAttachments(relations: Relation[]): AttachmentInfo[] {
    return relations
        .filter((r) => r.rel === "AttachedFile" && r.attributes?.name)
        .map((r) => ({
            id: extractAttachmentId(r.url),
            filename: r.attributes?.name!,
            size: r.attributes?.resourceSize ?? 0,
            createdDate: r.attributes?.resourceCreatedDate ?? "",
        }));
}

/** Filter attachment relations by date range and filename prefix/suffix */
export function filterAttachments(relations: Relation[], filter: AttachmentFilter): Relation[] {
    return relations
        .filter((r) => r.rel === "AttachedFile" && r.attributes?.name)
        .filter((r) => {
            const attrs = r.attributes!;

            if (filter.from && (!attrs.resourceCreatedDate || new Date(attrs.resourceCreatedDate) < filter.from))
                return false;

            if (filter.to && (!attrs.resourceCreatedDate || new Date(attrs.resourceCreatedDate) > filter.to))
                return false;

            if (filter.prefix && !attrs.name?.startsWith(filter.prefix)) return false;

            if (filter.suffix && !attrs.name?.endsWith(filter.suffix)) return false;
            return true;
        });
}
