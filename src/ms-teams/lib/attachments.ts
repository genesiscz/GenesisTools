import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { decodeTeamsString } from "./decode";
import { parseAmsObjectId } from "./disk-cache";
import type { Attachment } from "./types";

export function parseAttachments(properties: unknown, extraHtml?: string | null): Attachment[] {
    const out: Attachment[] = [];
    const props = asRecord(properties);
    const files = parseJsonField(props?.files);

    if (Array.isArray(files)) {
        for (const file of files) {
            const rec = asRecord(file);

            if (!rec) {
                continue;
            }

            const info = asRecord(rec.fileInfo) ?? {};
            const name = decodeTeamsString(rec.fileName ?? info.fileName);
            const url = decodeTeamsString(rec.objectUrl ?? rec.fileUrl ?? info.fileUrl);
            const itemId = decodeTeamsString(rec.itemid ?? rec.itemId ?? info.itemId) || null;
            const mimeHint = decodeTeamsString(rec.fileType ?? info.fileType) || null;

            if (!name && !url) {
                continue;
            }

            out.push({
                name: name || "attachment",
                mimeHint,
                url: url || null,
                itemId,
                localPath: null,
            });
        }
    }

    if (extraHtml) {
        for (const image of parseAmsImageTags(extraHtml)) {
            const existing = out.find(
                (a) => a.url === image.url || (image.itemId !== null && a.itemId === image.itemId)
            );

            if (existing) {
                if (!existing.itemId && image.itemId) {
                    existing.itemId = image.itemId;
                }

                continue;
            }

            out.push(image);
        }
    }

    return out;
}

function parseAmsImageTags(html: string): Attachment[] {
    const out: Attachment[] = [];
    const imgTagRe = /<img\b[^>]*>/gi;
    let match: RegExpExecArray | null = imgTagRe.exec(html);

    while (match) {
        const tag = match[0];
        const src = htmlAttr(tag, "src");
        const itemType = htmlAttr(tag, "itemtype") ?? "";
        const itemId = htmlAttr(tag, "itemid") || parseAmsObjectId(src);
        const isAms = /AMSImage/i.test(itemType) || Boolean(parseAmsObjectId(src));

        if (isAms && (src || itemId)) {
            out.push({
                name: htmlAttr(tag, "alt") || "image",
                mimeHint: htmlAttr(tag, "itemscope") || "png",
                url: src,
                itemId,
                localPath: null,
            });
        }

        match = imgTagRe.exec(html);
    }

    return out;
}

function htmlAttr(tag: string, name: string): string | null {
    const re = new RegExp(`\\b${name}=["']([^"']*)["']`, "i");
    return tag.match(re)?.[1] ?? null;
}

export function parseMentions(properties: unknown): { id: string; name: string }[] {
    const props = asRecord(properties);
    const mentions = parseJsonField(props?.mentions);

    if (!Array.isArray(mentions)) {
        return [];
    }

    const out: { id: string; name: string }[] = [];

    for (const mention of mentions) {
        const rec = asRecord(mention);

        if (!rec) {
            continue;
        }

        const id = decodeTeamsString(rec.mri ?? rec.userMri ?? rec.id);
        const name = decodeTeamsString(rec.displayName ?? rec.name);

        if (id || name) {
            out.push({ id, name });
        }
    }

    return out;
}

export function parseLinks(properties: unknown): string[] {
    const props = asRecord(properties);
    const links = parseJsonField(props?.links);

    if (!Array.isArray(links)) {
        return [];
    }

    const out: string[] = [];

    for (const link of links) {
        if (typeof link === "string") {
            const url = decodeTeamsString(link);

            if (url) {
                out.push(url);
            }

            continue;
        }

        const rec = asRecord(link);
        const url = decodeTeamsString(rec?.url ?? rec?.href);

        if (url) {
            out.push(url);
        }
    }

    return out;
}

export function parseReactions(annotations: unknown): { emotion: string; count: number }[] {
    const rec = asRecord(annotations);
    const emotions = asRecord(rec?.emotions);

    if (!emotions) {
        return [];
    }

    const out: { emotion: string; count: number }[] = [];

    for (const [emotion, count] of Object.entries(emotions)) {
        const n = typeof count === "number" ? count : Number(count);

        if (Number.isFinite(n) && n > 0) {
            out.push({ emotion, count: n });
        }
    }

    return out;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_HOST_SUFFIXES = [
    "skype.com",
    "teams.microsoft.com",
    "sharepoint.com",
    "sharepointonline.com",
    "office.com",
    "office.net",
    "1drv.ms",
    "onedrive.com",
    "microsoftonline.com",
];

export function isAllowedAttachmentUrl(url: string): boolean {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    if (parsed.protocol !== "https:") {
        return false;
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (isBlockedHost(host)) {
        return false;
    }

    return ATTACHMENT_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export async function downloadAttachments(args: {
    attachments: Attachment[];
    outDir: string;
    fetchImpl?: typeof fetch;
    usedNames?: Set<string>;
}): Promise<{ attachments: Attachment[]; failed: number }> {
    const { attachments, outDir } = args;
    const fetchImpl = args.fetchImpl ?? fetch;
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    let failed = 0;
    const result: Attachment[] = [];
    const usedNames = args.usedNames ?? new Set<string>();

    for (const attachment of attachments) {
        if (attachment.localPath && existsSync(attachment.localPath)) {
            result.push(attachment);
            continue;
        }

        if (!attachment.url || attachment.url.startsWith("file:")) {
            result.push(attachment);
            continue;
        }

        if (!isAllowedAttachmentUrl(attachment.url)) {
            logger.debug({ url: attachment.url }, "[ms-teams] skipped attachment URL outside Teams/SharePoint");
            failed += 1;
            result.push(attachment);
            continue;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);

        try {
            const res = await fetchImpl(attachment.url, { redirect: "follow", signal: controller.signal });
            const finalUrl = res.url || attachment.url;

            if (!isAllowedAttachmentUrl(finalUrl)) {
                logger.debug({ url: finalUrl }, "[ms-teams] skipped redirected attachment URL");
                failed += 1;
                result.push(attachment);
                continue;
            }

            if (!res.ok) {
                logger.debug({ status: res.status, url: attachment.url }, "[ms-teams] attachment download failed");
                failed += 1;
                result.push(attachment);
                continue;
            }

            const body = await readCappedBody(res, MAX_ATTACHMENT_BYTES);

            if (!body) {
                logger.debug({ url: attachment.url }, "[ms-teams] attachment exceeded size cap");
                failed += 1;
                result.push(attachment);
                continue;
            }

            const dest = uniqueDest(outDir, attachment.name || "attachment", attachment.itemId, usedNames);
            await Bun.write(dest, body);
            result.push({ ...attachment, localPath: dest });
        } catch (err) {
            logger.debug({ err, url: attachment.url }, "[ms-teams] attachment download threw");
            failed += 1;
            result.push(attachment);
        } finally {
            clearTimeout(timer);
        }
    }

    return { attachments: result, failed };
}

function isBlockedHost(host: string): boolean {
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
        return true;
    }

    const parts = host.split(".").map((p) => Number(p));

    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        const [a, b] = parts;

        if (a === 10 || a === 127 || a === 0) {
            return true;
        }

        if (a === 169 && b === 254) {
            return true;
        }

        if (a === 192 && b === 168) {
            return true;
        }

        if (a === 172 && b >= 16 && b <= 31) {
            return true;
        }
    }

    return false;
}

async function readCappedBody(res: Response, maxBytes: number): Promise<Uint8Array | null> {
    const headerLen = Number(res.headers.get("content-length"));

    if (Number.isFinite(headerLen) && headerLen > maxBytes) {
        return null;
    }

    if (!res.body) {
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.byteLength > maxBytes ? null : buf;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        if (!value) {
            continue;
        }

        total += value.byteLength;

        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }

        chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return out;
}

export function parseJsonField(value: unknown): unknown {
    if (value === null || value === undefined || value === "<Undefined>") {
        return null;
    }

    if (typeof value !== "string") {
        return value;
    }

    const decoded = decodeTeamsString(value).trim();

    if (!decoded || decoded === "[]" || decoded === "null") {
        if (decoded === "[]") {
            return [];
        }

        return null;
    }

    try {
        return SafeJSON.parse(decoded, { strict: true });
    } catch (err) {
        logger.debug({ err }, "[ms-teams] properties JSON field was not parseable");
        return decoded;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    return null;
}

function sanitizeFilename(name: string): string {
    const base =
        name
            .replace(/[/\\?%*:|"<>]/g, "_")
            .replace(/\s+/g, " ")
            .trim() || "attachment";
    return base.slice(0, 120);
}

function uniqueDest(dir: string, name: string, itemId: string | null, used: Set<string>): string {
    const safe = sanitizeFilename(name);
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    const suffix = itemId ? itemId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) : "";
    let candidate = suffix ? `${stem}-${suffix}${ext}` : safe;
    let n = 2;

    while (used.has(candidate)) {
        candidate = `${stem}-${n}${ext}`;
        n += 1;
    }

    used.add(candidate);
    return join(dir, candidate);
}
