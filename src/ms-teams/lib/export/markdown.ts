import { formatDateTime } from "@genesiscz/utils/date";
import { isImageAttachment } from "../media";
import type { ThreadExport } from "../types";

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

        if (message.system) {
            lines.push(`*${message.system}*`);
        } else if (message.text.trim()) {
            lines.push(message.text);
        } else if (message.attachments.length === 0) {
            lines.push("_(no text)_");
        }

        if (message.reactions.length > 0) {
            lines.push("");
            lines.push(message.reactions.map((r) => `${r.emotion} ×${r.count}`).join(" · "));
        }

        for (const attachment of message.attachments) {
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
