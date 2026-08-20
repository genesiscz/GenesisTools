import { formatDateTime } from "@genesiscz/utils/date";
import { logger } from "@genesiscz/utils/logger";
import { teamsHtmlToMarkdown } from "../html-to-markdown";
import { isImageAttachment } from "../media";
import type { Attachment, ExportedMessage, ThreadExport } from "../types";

const log = logger.scoped("ms-teams").log;

export function renderMarkdown(thread: ThreadExport): string {
    const lines: string[] = [];
    const { conversation, messages } = thread;
    lines.push(`# ${conversation.title}`);
    lines.push("");
    lines.push(
        `${conversation.type} · ${conversation.messageCount} messages · cached ${conversation.cachedFrom ?? "—"} → ${conversation.cachedTo ?? "—"}`
    );
    lines.push("");
    lines.push(`_${conversation.completenessNote}_`);
    lines.push("");

    if (conversation.members.length > 0) {
        lines.push(`Members: ${conversation.members.map((m) => m.displayName).join(", ")}`);
        lines.push("");
    }

    for (const message of messages) {
        const when = formatDateTime(message.time, { absolute: "datetime" });
        const who = message.from.displayName + (message.isFromMe ? " (me)" : "");
        lines.push(`## ${when} · ${who}`);
        lines.push("");

        if (message.replyTo) {
            lines.push(`> reply to ${message.replyTo.from}: ${message.replyTo.excerpt}`);
            lines.push("");
        }

        const body = message.system ? "" : messageBodyMarkdown(message);

        if (message.system) {
            lines.push(`*${message.system}*`);
        } else if (body) {
            lines.push(body);
        } else if (message.attachments.length === 0) {
            lines.push("_(no text)_");
        }

        if (message.reactions.length > 0) {
            lines.push("");
            lines.push(message.reactions.map((r) => `${r.emotion} ×${r.count}`).join(" · "));
        }

        for (const attachment of message.attachments) {
            if (attachmentShownInMarkdown(body, attachment)) {
                continue;
            }

            const href = attachment.localPath ?? attachment.url;

            if (!href) {
                continue;
            }

            lines.push("");

            if (attachment.localPath && isImageAttachment(attachment)) {
                lines.push(`![${attachment.name}](${href})`);
            } else {
                lines.push(`[${attachment.name}](${href})`);
            }
        }

        lines.push("");
    }

    return `${lines.join("\n").trim()}\n`;
}

function messageBodyMarkdown(message: ExportedMessage): string {
    if (message.html?.trim()) {
        try {
            const converted = teamsHtmlToMarkdown(message.html, message.attachments);

            if (converted) {
                return converted;
            }
        } catch (err) {
            log.debug({ err, messageId: message.id }, "[ms-teams] html to markdown failed");
        }
    }

    return message.text.trim();
}

function attachmentShownInMarkdown(markdown: string, attachment: Attachment): boolean {
    if (attachment.localPath && markdown.includes(attachment.localPath)) {
        return true;
    }

    if (attachment.itemId && markdown.includes(attachment.itemId)) {
        return true;
    }

    // A remote inline image (no localPath, no AMS itemId) is already in the
    // body by its URL; listing it again below would duplicate it.
    if (attachment.url && markdown.includes(attachment.url)) {
        return true;
    }

    return false;
}
