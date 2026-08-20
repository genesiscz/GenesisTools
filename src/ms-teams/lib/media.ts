import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@genesiscz/utils/logger";
import { findDiskCacheImage, parseAmsObjectId } from "./disk-cache";
import { liveDiskCacheDir, mediaDir } from "./paths";
import type { Attachment, ThreadExport } from "./types";

const log = logger.scoped("ms-teams").log;

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

export interface MaterializeMediaOptions {
    cacheDir?: string;
    destDir?: string;
}

export async function materializeThreadMedia(
    thread: ThreadExport,
    opts: MaterializeMediaOptions = {}
): Promise<ThreadExport> {
    const messages = [];

    for (const message of thread.messages) {
        if (message.attachments.length === 0) {
            messages.push(message);
            continue;
        }

        const attachments = await materializeAttachments(message.attachments, opts);
        const text = shouldDropImagePlaceholder(message.text, attachments) ? "" : message.text;
        messages.push({ ...message, attachments, text });
    }

    return { ...thread, messages };
}

export async function materializeAttachments(
    attachments: Attachment[],
    opts: MaterializeMediaOptions = {}
): Promise<Attachment[]> {
    const destDir = opts.destDir ?? mediaDir();
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const cacheDir = opts.cacheDir ?? liveDiskCacheDir();
    const out: Attachment[] = [];

    for (const attachment of attachments) {
        out.push(await materializeAttachment({ attachment, destDir, cacheDir }));
    }

    return out;
}

export function isImageAttachment(attachment: Attachment): boolean {
    const hint = (attachment.mimeHint ?? "").toLowerCase();
    const name = (attachment.name ?? "").toLowerCase();
    const path = (attachment.localPath ?? attachment.url ?? "").toLowerCase();

    if (
        hint.includes("png") ||
        hint.includes("jpg") ||
        hint.includes("jpeg") ||
        hint.includes("gif") ||
        hint.includes("webp") ||
        hint.startsWith("image")
    ) {
        return true;
    }

    if (/\.(png|jpe?g|gif|webp)(?:\?|$)/.test(name) || /\.(png|jpe?g|gif|webp)(?:\?|$)/.test(path)) {
        return true;
    }

    if ((attachment.url ?? "").includes("/views/imgo") || (attachment.url ?? "").includes("/views/imgpsh")) {
        return true;
    }

    return name === "image" || name === "img";
}

export function toFileUrl(filePath: string): string {
    return pathToFileURL(filePath).href;
}

async function materializeAttachment(args: {
    attachment: Attachment;
    destDir: string;
    cacheDir: string;
}): Promise<Attachment> {
    const { attachment, destDir, cacheDir } = args;

    if (attachment.localPath && existsSync(attachment.localPath)) {
        return attachment;
    }

    const objectId = attachment.itemId?.startsWith("0-") ? attachment.itemId : parseAmsObjectId(attachment.url);

    if (!objectId) {
        return attachment;
    }

    const existing = existingMedia(destDir, objectId);

    if (existing) {
        return withLocalFile(attachment, objectId, existing.path, existing.ext);
    }

    const extracted = findDiskCacheImage(cacheDir, objectId);

    if (!extracted) {
        log.debug({ objectId }, "[ms-teams] no disk-cache hit for AMS object");
        return attachment;
    }

    const dest = join(destDir, `${objectId}.${extracted.ext}`);
    await Bun.write(dest, extracted.bytes);
    chmodSync(dest, 0o600);
    log.debug({ objectId, dest, bytes: extracted.bytes.length }, "[ms-teams] extracted AMS image from disk cache");
    return withLocalFile(attachment, objectId, dest, extracted.ext);
}

function existingMedia(dir: string, objectId: string): { path: string; ext: string } | null {
    for (const ext of IMAGE_EXTS) {
        const path = join(dir, `${objectId}.${ext}`);

        if (existsSync(path)) {
            return { path, ext: ext === "jpeg" ? "jpg" : ext };
        }
    }

    return null;
}

function withLocalFile(attachment: Attachment, objectId: string, localPath: string, ext: string): Attachment {
    const filename = `${objectId}.${ext}`;
    return {
        ...attachment,
        itemId: objectId,
        mimeHint: attachment.mimeHint || ext,
        localPath,
        name: attachment.name === "image" || attachment.name === "img" ? filename : attachment.name,
    };
}

function shouldDropImagePlaceholder(text: string, attachments: Attachment[]): boolean {
    if (!attachments.some((a) => a.localPath)) {
        return false;
    }

    const trimmed = text.trim().toLowerCase();
    return trimmed === "" || trimmed === "image" || trimmed === "img";
}
