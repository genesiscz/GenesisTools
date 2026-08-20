import { htmlToMarkdown } from "@genesiscz/utils/markdown/html-to-md";
import { decodeTeamsString } from "./decode";
import { parseAmsObjectId } from "./disk-cache";
import { sanitizeHtml } from "./export/html";
import type { Attachment } from "./types";

/**
 * Convert a Teams RichText/Html body to markdown, keeping headings, lists, links,
 * emphasis, tables and code. Reply quotes are dropped (export already has replyTo).
 * AMS images with a local file become inline markdown images; unresolved AMS tags are dropped.
 */
export function teamsHtmlToMarkdown(html: unknown, attachments: Attachment[] = []): string {
    const raw = decodeTeamsString(html);

    if (!raw) {
        return "";
    }

    let prepared = stripReplyQuotes(raw);
    prepared = prepared.replace(/&nbsp;/gi, " ").replace(/\u00a0/g, " ");
    prepared = hoistOrphanNestedLists(prepared);
    prepared = rewriteImages(prepared, attachments);
    prepared = sanitizeHtml(prepared);

    return tidyMarkdown(htmlToMarkdown(prepared));
}

function stripReplyQuotes(html: string): string {
    return html.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, (block) => {
        if (/itemtype=["']http:\/\/schema\.skype\.com\/Reply["']/i.test(block)) {
            return "";
        }

        return block;
    });
}

/**
 * Teams often stores an indent as an empty <li> wrapping a nested list.
 * Fold that into the previous item so markdown keeps a real nested list.
 */
function hoistOrphanNestedLists(html: string): string {
    return html.replace(/<\/li>\s*<li>\s*<(ul|ol)\b/gi, "<$1");
}

function rewriteImages(html: string, attachments: Attachment[]): string {
    return html.replace(/<img\b[^>]*>/gi, (tag) => {
        if (/schema\.skype\.com\/(Emoji|CustomEmoji)/i.test(tag)) {
            const alt = htmlAttr(tag, "alt");

            return alt ? ` ${alt} ` : " ";
        }

        const src = htmlAttr(tag, "src") ?? "";
        const itemId = htmlAttr(tag, "itemid") ?? parseAmsObjectId(src);
        const attachment = findImageAttachment(attachments, src, itemId);

        if (attachment?.localPath) {
            return `<img src="${escapeAttr(attachment.localPath)}" alt="${escapeAttr(attachment.name)}" />`;
        }

        if (/schema\.skype\.com\/AMSImage/i.test(tag) || /asm\.skype\.com/i.test(src)) {
            return " ";
        }

        return tag;
    });
}

function findImageAttachment(attachments: Attachment[], src: string, itemId: string | null): Attachment | undefined {
    return attachments.find((attachment) => {
        if (src && attachment.url === src) {
            return true;
        }

        if (src && attachment.localPath === src) {
            return true;
        }

        if (itemId && attachment.itemId === itemId) {
            return true;
        }

        if (itemId && parseAmsObjectId(attachment.url) === itemId) {
            return true;
        }

        return false;
    });
}

function tidyMarkdown(markdown: string): string {
    return markdown
        .replace(/\\([#[\]_\\-])/g, "$1")
        .replace(/\u00a0/g, " ")
        .replace(/^(\s*)-(\s{2,})/gm, "$1- ")
        .replace(/^(\s*)(\d+)\.(\s{2,})/gm, "$1$2. ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function htmlAttr(tag: string, name: string): string | null {
    const match = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));

    return match?.[1] ?? null;
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
