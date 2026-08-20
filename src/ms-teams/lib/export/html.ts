import { formatDateTime } from "@genesiscz/utils/date";
import type { ThreadExport } from "../types";

export function renderHtml(thread: ThreadExport): string {
    const { conversation, messages } = thread;
    const items = messages
        .map((message) => {
            const when = escapeHtml(formatDateTime(message.time, { absolute: "datetime" }));
            const who = escapeHtml(message.from.displayName + (message.isFromMe ? " (me)" : ""));
            const reply = message.replyTo
                ? `<blockquote class="reply">reply to ${escapeHtml(message.replyTo.from)}: ${escapeHtml(message.replyTo.excerpt)}</blockquote>`
                : "";
            const body = message.html
                ? `<div class="html">${sanitizeHtml(message.html)}</div>`
                : `<p>${escapeHtml(message.text || "")}</p>`;
            const attachments = message.attachments
                .map((a) => {
                    const href = a.localPath ?? a.url;

                    if (!href) {
                        return "";
                    }

                    if (!isSafeHref(href)) {
                        return `<p class="file">${escapeHtml(a.name)}</p>`;
                    }

                    return `<p class="file"><a href="${escapeHtml(href)}">${escapeHtml(a.name)}</a></p>`;
                })
                .join("");
            const reactions =
                message.reactions.length > 0
                    ? `<p class="reactions">${message.reactions.map((r) => escapeHtml(`${r.emotion} ×${r.count}`)).join(" · ")}</p>`
                    : "";
            const nested = message.replyToId ? " nested" : "";
            return `<article class="msg${nested}"><header>${when} · ${who}</header>${reply}${body}${attachments}${reactions}</article>`;
        })
        .join("\n");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(conversation.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; }
  h1 { font-size: 1.4rem; }
  .meta { color: GrayText; font-size: 0.9rem; }
  article { border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); padding: 0.8rem 0; }
  article.nested { margin-left: 1.5rem; }
  header { font-size: 0.85rem; color: GrayText; margin-bottom: 0.35rem; }
  blockquote.reply { margin: 0 0 0.5rem; padding-left: 0.75rem; border-left: 3px solid color-mix(in srgb, CanvasText 25%, transparent); color: GrayText; }
  .html img { max-width: 100%; height: auto; }
</style>
</head>
<body>
<h1>${escapeHtml(conversation.title)}</h1>
<p class="meta">${escapeHtml(conversation.type)} · ${conversation.messageCount} messages · ${escapeHtml(conversation.cachedFrom ?? "—")} → ${escapeHtml(conversation.cachedTo ?? "—")}</p>
<p class="meta">${escapeHtml(conversation.completenessNote)}</p>
${items}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeHtml(html: string): string {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/javascript:/gi, "");
}

function isSafeHref(href: string): boolean {
    const trimmed = href.trim();
    return /^(https?:\/\/|\/|\.\/)/i.test(trimmed) && !/^\s*javascript:/i.test(trimmed);
}
