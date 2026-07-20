import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { generateAttachmentId } from "./ids";
import { handoffLogDir } from "./log-store";

const log = logger.child({ component: "handoff:attachments" });

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    log: "text/plain",
    md: "text/markdown",
    json: "application/json",
    jsonl: "application/x-ndjson",
    diff: "text/x-diff",
    patch: "text/x-diff",
    html: "text/html",
    mp4: "video/mp4",
    mov: "video/quicktime",
    zip: "application/zip",
};

export function mimeForFilename(filename: string): string {
    const ext = extname(filename).replace(/^\./, "").toLowerCase();
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function attachmentsRoot(base?: string): string {
    return join(handoffLogDir(base), "attachments");
}

/**
 * §6.3 layout: attachments/<handoffId>/<attachmentId>.<ext>. The ext comes from
 * the stored filename, so the path is derivable from the attach event alone
 * (fold + routes never scan the directory).
 */
export function attachmentFilePath(handoffId: string, attachmentId: string, filename: string, base?: string): string {
    const ext = extname(filename).replace(/^\./, "").toLowerCase() || "bin";
    return join(attachmentsRoot(base), handoffId, `${attachmentId}.${ext}`);
}

export interface IngestedAttachment {
    attachmentId: string;
    filename: string;
    mime: string;
    bytes: number;
}

/** MCP attach_file path: copy a local file into the store (immutable once written). */
export function ingestAttachmentFromPath(handoffId: string, sourcePath: string, base?: string): IngestedAttachment {
    if (!existsSync(sourcePath)) {
        throw new Error(`attach_file: no file at "${sourcePath}" — pass an absolute path on this machine.`);
    }

    const stats = statSync(sourcePath);

    if (!stats.isFile()) {
        throw new Error(`attach_file: "${sourcePath}" is not a regular file.`);
    }

    if (stats.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
            `attach_file: "${sourcePath}" is ${stats.size} bytes — the cap is ${MAX_ATTACHMENT_BYTES} (10 MB).`
        );
    }

    const attachmentId = generateAttachmentId();
    const filename = basename(sourcePath);
    const dest = attachmentFilePath(handoffId, attachmentId, filename, base);
    mkdirSync(join(attachmentsRoot(base), handoffId), { recursive: true });
    copyFileSync(sourcePath, dest);
    log.info({ handoffId, attachmentId, filename, bytes: stats.size, dest }, "attachment ingested from path");

    return { attachmentId, filename, mime: mimeForFilename(filename), bytes: stats.size };
}

/** Dashboard upload path: write pasted/dropped bytes into the store. */
export function ingestAttachmentBytes(
    handoffId: string,
    filename: string,
    bytes: Uint8Array,
    base?: string
): IngestedAttachment {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment is ${bytes.byteLength} bytes — the cap is ${MAX_ATTACHMENT_BYTES} (10 MB).`);
    }

    const attachmentId = generateAttachmentId();
    const safeName = basename(filename.trim() || "pasted.bin");
    const dest = attachmentFilePath(handoffId, attachmentId, safeName, base);
    mkdirSync(join(attachmentsRoot(base), handoffId), { recursive: true });
    writeFileSync(dest, bytes);
    log.info(
        { handoffId, attachmentId, filename: safeName, bytes: bytes.byteLength, dest },
        "attachment ingested from bytes"
    );

    return { attachmentId, filename: safeName, mime: mimeForFilename(safeName), bytes: bytes.byteLength };
}
