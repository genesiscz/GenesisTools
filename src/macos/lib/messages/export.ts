import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type {
    AttachmentInfo,
    ExportConversationOptions,
    iMessagesDatabase,
    MessageInfo,
} from "@genesiscz/utils/macos/iMessagesDatabase";

export interface MessagesAttachmentFilter {
    ids?: Set<number>;
    nameRegex?: RegExp;
}

export interface ResolvedChatAttachment extends AttachmentInfo {
    messageRowid: number;
    resolvedPath: string;
    exists: boolean;
}

export interface SaveConversationExportOptions {
    db: iMessagesDatabase;
    chatIdentifier: string;
    outputDir: string;
    from?: Date;
    to?: Date;
    filter?: string;
    /** Copy attachments into output-dir/attachments/. */
    saveAttachments?: boolean;
    /** Skip conversation.md; implies saveAttachments. */
    attachmentsOnly?: boolean;
    /** Markdown filename inside output-dir (default conversation.md). */
    mdName?: string;
    format?: "text" | "markdown";
    resolveContacts?: boolean;
    groupByTime?: boolean;
}

export interface SaveConversationExportResult {
    outputDir: string;
    markdownPath?: string;
    attachmentsDir?: string;
    attachmentTotal: number;
    matched: number;
    saved: number;
    missing: number;
    skippedByFilter: number;
    savedNames: string[];
    missingIds: number[];
}

/**
 * Parse `--attachments-filter`.
 * Digit / `#` / comma / space lists select by attachment ROWID.
 * Anything else is a case-insensitive RegExp against transfer name, filename, or id.
 */
export function parseAttachmentsFilter(raw?: string): MessagesAttachmentFilter | undefined {
    if (!raw?.trim()) {
        return undefined;
    }

    const trimmed = raw.trim();

    if (/^[\d#,\s]+$/.test(trimmed)) {
        const ids = new Set(
            trimmed
                .split(/[,\s]+/)
                .map((part) => Number.parseInt(part.replace(/^#/, ""), 10))
                .filter((n) => !Number.isNaN(n))
        );

        if (ids.size === 0) {
            // `'#'` and `','` pass the shape test but name no id at all, and an
            // empty id set excludes EVERY attachment: the export then reported
            // "0 saved" and wrote an empty directory with no error.
            logger.debug({ filter: trimmed }, "[messages/export] id filter names no ids");
            throw new Error(`--attachments-filter "${trimmed}" names no attachment ids. Use #ids, e.g. '#12, 34'.`);
        }

        return { ids };
    }

    let nameRegex: RegExp;

    try {
        nameRegex = new RegExp(trimmed, "i");
    } catch (err) {
        // `--attachments-filter '*.pdf'` is the obvious thing to type and is not
        // a valid regex; it used to exit with a raw SyntaxError stack.
        logger.debug({ err, filter: trimmed }, "[messages/export] unusable attachment filter");
        throw new Error(
            `--attachments-filter takes #ids or a name REGEX; "${trimmed}" is not a valid one ` +
                `(${err instanceof Error ? err.message : String(err)}). For names ending in .pdf use '\\.pdf$'.`
        );
    }

    return { nameRegex };
}

export function attachmentMatchesFilter(att: AttachmentInfo, filter?: MessagesAttachmentFilter): boolean {
    if (!filter) {
        return true;
    }

    if (filter.ids) {
        return filter.ids.has(att.rowid);
    }

    if (filter.nameRegex) {
        const name = att.transferName ?? att.filename ?? "";
        return filter.nameRegex.test(name) || filter.nameRegex.test(String(att.rowid));
    }

    return true;
}

const UUID_NAME_RE = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}(\.[^.]+)?$/;
const USELESS_EXTS = new Set([".pluginpayloadattachment", ".pluginpayload", ".tmp", ".dat", ".bin"]);

const MIME_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/php": "php",
    "application/zip": "zip",
    "application/json": "json",
};

/** True when the name is a UUID / pluginPayload stub without a useful extension. */
export function isOpaqueAttachmentName(name: string): boolean {
    const base = basename(name);
    const ext = extname(base).toLowerCase();

    if (USELESS_EXTS.has(ext)) {
        return true;
    }

    if (UUID_NAME_RE.test(base) && (!ext || USELESS_EXTS.has(ext))) {
        return true;
    }

    return false;
}

/** Sniff a real extension from leading bytes (PNG/JPEG/GIF/WEBP/HEIC/PDF/MP4/MOV). */
export function sniffAttachmentExt(buf: Buffer): string | null {
    if (buf.length < 12) {
        return null;
    }

    if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
        return "png";
    }

    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return "jpg";
    }

    if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") {
        return "gif";
    }

    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
        return "webp";
    }

    if (buf.toString("ascii", 0, 4) === "%PDF") {
        return "pdf";
    }

    // HEIC/HEIF: ....ftypheic / mif1 / heix / …
    if (buf.toString("ascii", 4, 8) === "ftyp") {
        const brand = buf.toString("ascii", 8, 12).toLowerCase();

        if (
            brand.startsWith("heic") ||
            brand.startsWith("heix") ||
            brand.startsWith("mif1") ||
            brand.startsWith("msf1")
        ) {
            return "heic";
        }

        if (brand.startsWith("qt") || brand === "mov ") {
            return "mov";
        }

        // mp42 / isom / iso2 / M4V / …
        return "mp4";
    }

    return null;
}

function extFromMime(mimeType: string | null): string | null {
    if (!mimeType) {
        return null;
    }

    const key = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    return MIME_EXT[key] ?? null;
}

/** The first `count` bytes of a file, without reading the rest of it. */
function readMagicBytes(path: string, count: number): Buffer {
    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(count);
        const read = readSync(fd, buffer, 0, count, 0);

        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

/**
 * Stable on-disk name: `{rowid}-{readable}.{ext}`.
 * Opaque `*.pluginPayloadAttachment` / UUID stubs get a sniffed extension (png/mp4/…).
 */
export function messagesAttachmentFileName(att: AttachmentInfo, opts?: { resolvedPath?: string }): string {
    const raw = att.transferName ?? (att.filename ? basename(att.filename) : null) ?? `attachment-${att.rowid}`;
    const opaque = isOpaqueAttachmentName(raw);
    let stem = basename(raw, extname(raw)).replace(/[^\w.-]+/g, "_") || `attachment-${att.rowid}`;
    let ext = extname(raw).replace(/^\./, "").toLowerCase();

    if (opaque || !ext || USELESS_EXTS.has(`.${ext}`)) {
        let sniffed: string | null = null;

        if (opts?.resolvedPath && existsSync(opts.resolvedPath)) {
            // Read only the magic bytes. `readFileSync(...).subarray(0, 32)` pulled
            // whole videos into memory to look at 32 of their bytes.
            try {
                sniffed = sniffAttachmentExt(readMagicBytes(opts.resolvedPath, 32));
            } catch (err) {
                logger.debug({ err, path: opts.resolvedPath }, "[messages/export] magic-byte sniff failed");
                sniffed = null;
            }
        }

        ext = sniffed ?? extFromMime(att.mimeType) ?? "bin";

        // Drop UUID stem → short label by type
        if (UUID_NAME_RE.test(basename(raw)) || opaque) {
            if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "heic") {
                stem = "image";
            } else if (ext === "mp4" || ext === "mov") {
                stem = "video";
            } else if (ext === "mp3" || ext === "m4a") {
                stem = "audio";
            } else if (ext === "pdf") {
                stem = "document";
            } else {
                stem = "file";
            }
        }
    }

    return `${att.rowid}-${stem}.${ext}`;
}

export function resolveAttachmentPath(filename: string | null): { resolvedPath: string; exists: boolean } {
    if (!filename) {
        return { resolvedPath: "", exists: false };
    }

    const resolvedPath = filename.replace(/^~/, homedir());
    return { resolvedPath, exists: Boolean(resolvedPath) && existsSync(resolvedPath) };
}

export function listChatAttachments(
    db: iMessagesDatabase,
    chatIdentifier: string,
    options?: { from?: Date; to?: Date }
): ResolvedChatAttachment[] {
    return collectChatAttachments(
        db.getAllMessages(chatIdentifier, {
            from: options?.from,
            to: options?.to,
            includeAttachments: true,
        })
    );
}

/** Every distinct attachment carried by an already-loaded run of messages. */
export function collectChatAttachments(messages: MessageInfo[]): ResolvedChatAttachment[] {
    const out: ResolvedChatAttachment[] = [];
    const seen = new Set<number>();

    for (const msg of messages) {
        for (const att of msg.attachments ?? []) {
            if (seen.has(att.rowid)) {
                continue;
            }

            seen.add(att.rowid);
            const { resolvedPath, exists } = resolveAttachmentPath(att.filename);
            out.push({
                ...att,
                messageRowid: msg.rowid,
                resolvedPath,
                exists,
            });
        }
    }

    return out;
}

export function saveConversationExport(options: SaveConversationExportOptions): SaveConversationExportResult {
    const outputDir = resolve(options.outputDir);
    // `attachmentsOnly` implies saving attachments, so "neither" cannot happen:
    // the guard that used to sit here was unreachable.
    const writeMarkdown = !options.attachmentsOnly;
    const shouldSaveAttachments = options.attachmentsOnly === true || options.saveAttachments === true;

    mkdirSync(outputDir, { recursive: true });

    const filter = parseAttachmentsFilter(options.filter);
    // One paging pass for both jobs. The attachment listing and the markdown
    // body used to page the whole chat separately over the same date range,
    // which is two full walks (and two attachment joins) of up to 50 000 rows.
    const loaded = options.db.loadConversation(options.chatIdentifier, {
        from: options.from,
        to: options.to,
        includeAttachments: true,
    });
    const allAttachments = collectChatAttachments(loaded.messages);
    const matched = allAttachments.filter((att) => attachmentMatchesFilter(att, filter));
    const matchedIds = new Set(matched.map((att) => att.rowid));
    const skippedByFilter = allAttachments.length - matched.length;

    const attachmentsDir = join(outputDir, "attachments");
    const savedNames: string[] = [];
    const missingIds: number[] = [];
    const hrefById = new Map<number, string>();

    if (shouldSaveAttachments) {
        mkdirSync(attachmentsDir, { recursive: true });

        for (const att of matched) {
            if (!att.exists || !att.resolvedPath) {
                missingIds.push(att.rowid);
                logger.debug(
                    { rowid: att.rowid, filename: att.filename },
                    "[messages/export] attachment missing on disk"
                );
                continue;
            }

            const name = messagesAttachmentFileName(att, { resolvedPath: att.resolvedPath });
            const dest = join(attachmentsDir, name);

            // One unreadable attachment (a permission error, an iCloud stub that
            // vanished between the listing and the copy) used to abort the whole
            // export after some files had been written and before conversation.md
            // was. It is reported the same way as a missing one instead.
            try {
                copyFileSync(att.resolvedPath, dest);
            } catch (err) {
                missingIds.push(att.rowid);
                logger.warn(
                    { err, rowid: att.rowid, from: att.resolvedPath, dest },
                    "[messages/export] attachment copy failed — skipped"
                );
                continue;
            }

            savedNames.push(name);
            hrefById.set(att.rowid, `attachments/${name}`);
        }
    }

    let markdownPath: string | undefined;

    if (writeMarkdown) {
        const exportOpts: ExportConversationOptions = {
            from: options.from,
            to: options.to,
            format: options.format ?? "markdown",
            resolveContacts: options.resolveContacts,
            groupByTime: options.groupByTime,
            preloaded: loaded,
            formatAttachment: (att) => {
                const href = hrefById.get(att.rowid);
                const savedLabel = href ? basename(href) : null;
                const rawLabel = att.transferName ?? (att.filename ? basename(att.filename) : null) ?? "attachment";
                const label =
                    !isOpaqueAttachmentName(rawLabel) && extname(rawLabel)
                        ? basename(rawLabel)
                        : (savedLabel ?? rawLabel);

                if (href) {
                    return `[${label}](${href}) #${att.rowid}`;
                }

                if (shouldSaveAttachments && matchedIds.has(att.rowid)) {
                    return `${label} #${att.rowid} (missing on disk)`;
                }

                return `${rawLabel} #${att.rowid}`;
            },
        };

        const body = options.db.exportConversation(options.chatIdentifier, exportOpts);
        const mdName = options.mdName?.trim() || "conversation.md";
        markdownPath = join(outputDir, basename(mdName));
        writeFileSync(markdownPath, `${body}\n`, "utf8");
    }

    logger.debug(
        {
            outputDir,
            attachmentTotal: allAttachments.length,
            matched: matched.length,
            saved: savedNames.length,
            missing: missingIds.length,
        },
        "[messages/export] done"
    );

    return {
        outputDir,
        markdownPath,
        attachmentsDir: shouldSaveAttachments ? attachmentsDir : undefined,
        attachmentTotal: allAttachments.length,
        matched: matched.length,
        saved: savedNames.length,
        missing: missingIds.length,
        skippedByFilter,
        savedNames,
        missingIds,
    };
}
