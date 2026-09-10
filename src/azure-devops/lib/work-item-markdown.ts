import { rewriteImageUrls } from "@app/azure-devops/inline-images";
import { parseAttachments, parseRelations } from "@app/azure-devops/relations";
import type { WorkItemFull } from "@app/azure-devops/types";
import { formatBytes } from "@genesiscz/utils/format";
import { htmlToMarkdown } from "@genesiscz/utils/markdown/html-to-md";

/**
 * Markdown body for a work item: saved `.md` file and `tools azure-devops wi -f md` stdout.
 * Converts ADO HTML description and comments (headings, lists, images) rather than dumping tags.
 */
export function formatWorkItemMarkdown(item: WorkItemFull, imageMap?: Map<string, string>): string {
    const lines: string[] = [];

    lines.push(`# #${item.id}: ${item.title}`);
    lines.push("");
    lines.push("## Details");
    lines.push("");
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| State | ${item.state} |`);
    lines.push(`| Severity | ${item.severity || "N/A"} |`);
    lines.push(`| Assignee | ${item.assignee || "Unassigned"} |`);
    lines.push(`| Tags | ${item.tags || "None"} |`);
    lines.push(
        `| Created | ${item.created ? new Date(item.created).toLocaleString() : "N/A"} by ${item.createdBy || "Unknown"} |`
    );
    lines.push(`| Last Changed | ${item.changed ? new Date(item.changed).toLocaleString() : "N/A"} |`);
    lines.push(`| URL | ${item.url} |`);

    if (item.description) {
        lines.push("");
        lines.push("## Description");
        lines.push("");
        const descHtml = imageMap ? rewriteImageUrls(item.description, imageMap) : item.description;
        lines.push(htmlToMarkdown(descHtml));
    }

    if (item.relations && item.relations.length > 0) {
        const parsed = parseRelations(item.relations);
        lines.push("");
        lines.push("## Related Items");
        lines.push("");

        if (parsed.parent) {
            lines.push(`- **Parent**: #${parsed.parent}`);
        }

        if (parsed.children.length > 0) {
            lines.push(`- **Children**: ${parsed.children.map((id) => `#${id}`).join(", ")}`);
        }

        if (parsed.related.length > 0) {
            lines.push(`- **Related**: ${parsed.related.map((id) => `#${id}`).join(", ")}`);
        }
    }

    const attachments = parseAttachments(item.relations ?? []);
    if (attachments.length > 0) {
        lines.push("");
        lines.push("## Attachments");
        lines.push("");

        for (const att of attachments) {
            const date = att.createdDate ? new Date(att.createdDate).toLocaleDateString() : "";
            lines.push(`- ${att.filename} (${formatBytes(att.size)}${date ? `, ${date}` : ""})`);
        }
    }

    if (item.comments.length > 0) {
        lines.push("");
        lines.push(`## Comments (${item.comments.length})`);
        lines.push("");

        for (const comment of item.comments) {
            lines.push(`### ${comment.author} - ${new Date(comment.date).toLocaleString()}`);
            lines.push("");
            const commentHtml = imageMap ? rewriteImageUrls(comment.text, imageMap) : comment.text;
            lines.push(htmlToMarkdown(commentHtml));
            lines.push("");
        }
    }

    return lines.join("\n");
}
