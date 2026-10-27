import { rewriteImageSources, rewriteImageUrls, rewriteMarkdownImageUrls } from "@app/azure-devops/inline-images";
import { parseAttachments, parseRelations } from "@app/azure-devops/relations";
import type { Comment, WorkItemFull } from "@app/azure-devops/types";
import { formatBytes } from "@genesiscz/utils/format";
import { htmlToMarkdown } from "@genesiscz/utils/markdown/html-to-md";

/** One table cell: a `|` would open a column and a line break would open a row. */
export function tableCell(value: string): string {
    return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * A comment as markdown, its images pointed at the downloaded files when `imageMap` has them.
 * A markdown comment is used as is: the HTML converter would escape its `![` and `**` and join its lines.
 */
export function commentMarkdown(comment: Comment, imageMap?: Map<string, string>): string {
    if (comment.format !== "markdown") {
        return htmlToMarkdown(imageMap ? rewriteImageUrls(comment.text, imageMap) : comment.text);
    }

    // Only image destinations and `<img src>` change: the same URL in a code example stays as written.
    const text = imageMap
        ? rewriteImageSources(rewriteMarkdownImageUrls(comment.text, imageMap), imageMap)
        : comment.text;
    return text.trim();
}

/**
 * The description as markdown. An HTML-format field starts with a tag; a Markdown-format one may still hold inline
 * HTML and is used as is, because the HTML converter would collapse its line breaks into one line. The batch read
 * does not return `multilineFieldsFormat`.
 */
export function descriptionMarkdown(description: string, imageMap?: Map<string, string>): string {
    if (/^\s*<[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/i.test(description)) {
        return htmlToMarkdown(imageMap ? rewriteImageUrls(description, imageMap) : description);
    }

    return imageMap ? rewriteImageSources(rewriteMarkdownImageUrls(description, imageMap), imageMap) : description;
}

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
    lines.push(`| State | ${tableCell(item.state)} |`);
    lines.push(`| Severity | ${tableCell(item.severity || "N/A")} |`);
    lines.push(`| Assignee | ${tableCell(item.assignee || "Unassigned")} |`);
    lines.push(`| Tags | ${tableCell(item.tags || "None")} |`);
    lines.push(
        `| Created | ${item.created ? new Date(item.created).toLocaleString() : "N/A"} by ${tableCell(item.createdBy || "Unknown")} |`
    );
    lines.push(`| Last Changed | ${item.changed ? new Date(item.changed).toLocaleString() : "N/A"} |`);
    lines.push(`| URL | ${tableCell(item.url)} |`);

    if (item.description) {
        lines.push("");
        lines.push("## Description");
        lines.push("");
        lines.push(descriptionMarkdown(item.description, imageMap));
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
            lines.push(commentMarkdown(comment, imageMap));
            lines.push("");
        }
    }

    return lines.join("\n");
}
