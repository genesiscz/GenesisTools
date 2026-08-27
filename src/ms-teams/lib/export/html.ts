import { formatDateTime } from "@genesiscz/utils/date";
import { parseAmsObjectId } from "../disk-cache";
import { isImageAttachment, toFileUrl } from "../media";
import type { Attachment, ThreadExport } from "../types";
import { EXPORT_IMAGE_STYLE } from "./image-embed";

export function renderHtml(thread: ThreadExport): string {
    const { conversation, messages } = thread;
    const items = messages
        .map((message) => {
            const when = escapeHtml(formatDateTime(message.time, { absolute: "datetime" }));
            const who = escapeHtml(message.from.displayName + (message.isFromMe ? " (me)" : ""));
            const reply = message.replyTo
                ? `<blockquote class="reply">reply to ${escapeHtml(message.replyTo.from)}: ${escapeHtml(message.replyTo.excerpt)}</blockquote>`
                : "";
            const rewritten = message.html ? rewriteLocalMediaHtml(message.html, message.attachments) : null;
            const body = rewritten
                ? `<div class="html">${sanitizeHtml(rewritten)}</div>`
                : `<p>${escapeHtml(message.text || "")}</p>`;
            const attachments = message.attachments
                .map((a) => {
                    if (rewritten && attachmentShownInHtml(rewritten, a)) {
                        return "";
                    }

                    const href = a.localPath ? toFileUrl(a.localPath) : a.url;

                    if (!href) {
                        return "";
                    }

                    if (!isSafeHref(href)) {
                        return `<p class="file">${escapeHtml(a.name)}</p>`;
                    }

                    if (a.localPath && isImageAttachment(a)) {
                        return `<p class="file"><img src="${escapeHtml(href)}" alt="${escapeHtml(a.name)}" /></p>`;
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
  img { ${EXPORT_IMAGE_STYLE} width: auto; }
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

export function sanitizeHtml(html: string): string {
    let out = html.replace(/<!--[\s\S]*?-->/g, "");
    out = out.replace(
        /<(script|style|iframe|object|embed|form|link|meta|base|svg|math|frame|frameset|applet)\b[^>]*>[\s\S]*?<\/\1>/gi,
        ""
    );
    out = out.replace(
        /<(script|style|iframe|object|embed|form|link|meta|base|svg|math|frame|frameset|applet)\b[^>]*\/?>/gi,
        ""
    );
    out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    out = out.replace(/\ssrcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    out = out.replace(
        /\s(href|src|action|formaction|xlink:href|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
        (_full, name: string, raw: string) => {
            const quoted = raw.startsWith('"') || raw.startsWith("'");
            const value = quoted ? raw.slice(1, -1) : raw;
            const decoded = decodeHtmlEntities(value);

            if (!isSafeHref(decoded)) {
                return "";
            }

            return ` ${name}="${escapeHtml(decoded)}"`;
        }
    );
    return out;
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => fromCodePointSafe(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec: string) => fromCodePointSafe(Number(dec)))
        .replace(/&colon;/gi, ":")
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&");
}

function fromCodePointSafe(code: number): string {
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        return "";
    }

    return String.fromCodePoint(code);
}

function isSafeHref(href: string): boolean {
    const trimmed = href.trim();

    if (/^\s*(javascript|data):/i.test(trimmed)) {
        return false;
    }

    return /^(https?:\/\/|file:\/\/|\/|\.\/)/i.test(trimmed);
}

export function rewriteLocalMediaHtml(html: string, attachments: Attachment[]): string {
    let out = html;

    for (const attachment of attachments) {
        if (!attachment.localPath) {
            continue;
        }

        const fileUrl = toFileUrl(attachment.localPath);

        if (attachment.url) {
            out = out.replaceAll(attachment.url, fileUrl);
        }

        const objectId = attachment.itemId ?? parseAmsObjectId(attachment.url);

        if (objectId) {
            const re = new RegExp(`https://[^"'\\s>]+/objects/${escapeRegex(objectId)}/views/[^"'\\s>]+`, "gi");
            out = out.replace(re, fileUrl);
        }
    }

    return out;
}

function attachmentShownInHtml(html: string, attachment: Attachment): boolean {
    if (attachment.localPath && html.includes(attachment.localPath)) {
        return true;
    }

    if (attachment.itemId && html.includes(attachment.itemId)) {
        return true;
    }

    return false;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
