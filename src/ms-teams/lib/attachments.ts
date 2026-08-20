import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { decodeTeamsString } from "./decode";
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
        const imgRe = /src=["'](https:\/\/[^"']+)["'][^>]*itemtype=["']http:\/\/schema\.skype\.com\/AMSImage["']/gi;
        let match: RegExpExecArray | null = imgRe.exec(extraHtml);

        while (match) {
            const url = match[1];

            if (!out.some((a) => a.url === url)) {
                out.push({
                    name: "image",
                    mimeHint: "png",
                    url,
                    itemId: null,
                    localPath: null,
                });
            }

            match = imgRe.exec(extraHtml);
        }
    }

    return out;
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

export async function downloadAttachments(args: {
    attachments: Attachment[];
    outDir: string;
    fetchImpl?: typeof fetch;
}): Promise<{ attachments: Attachment[]; failed: number }> {
    const { attachments, outDir } = args;
    const fetchImpl = args.fetchImpl ?? fetch;
    await mkdir(outDir, { recursive: true });
    let failed = 0;
    const result: Attachment[] = [];

    for (const attachment of attachments) {
        if (!attachment.url || attachment.url.startsWith("file:")) {
            result.push(attachment);
            continue;
        }

        try {
            const res = await fetchImpl(attachment.url);

            if (!res.ok) {
                logger.debug({ status: res.status, url: attachment.url }, "[ms-teams] attachment download failed");
                failed += 1;
                result.push(attachment);
                continue;
            }

            const safe = sanitizeFilename(attachment.name || "attachment");
            const dest = join(outDir, safe);
            await Bun.write(dest, await res.arrayBuffer());
            result.push({ ...attachment, localPath: dest });
        } catch (err) {
            logger.debug({ err, url: attachment.url }, "[ms-teams] attachment download threw");
            failed += 1;
            result.push(attachment);
        }
    }

    return { attachments: result, failed };
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
        return SafeJSON.parse(decoded);
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
