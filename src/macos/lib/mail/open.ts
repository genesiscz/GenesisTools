import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { logger } from "@genesiscz/utils/logger";

/** `<id@host>`, ` id@host `, or a header value with extra text: the bare id inside the brackets. */
export function normalizeMessageId(raw: string): string {
    const trimmed = raw.trim();
    const bracketed = /<([^>]+)>/.exec(trimmed);
    return (bracketed ? bracketed[1] : trimmed).trim();
}

/** The `Message-ID` header of a raw message, read from the header block only (before the first blank line). */
export function messageIdFromRaw(raw: string): string | null {
    const headers = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
    const found = /^Message-ID:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/im.exec(headers);

    if (!found) {
        return null;
    }

    const id = normalizeMessageId(found[1].replace(/\r?\n[ \t]+/g, " "));
    return id.length > 0 ? id : null;
}

/** Mail's own link form, angle brackets percent-encoded: `message://%3Cid@host%3E`. */
export function mailMessageUrl(messageId: string): string {
    return `message://%3C${encodeURIComponent(messageId).replace(/%40/g, "@")}%3E`;
}

export type MailTarget = { rowid: number } | { messageId: string };

/**
 * Opens one message in Mail. A rowid (from `tools macos mail search`) is resolved to its Message-ID
 * through the message file. `open -a Mail` hands the URL over without waiting: a plain
 * `open message://...` gives up after about 2 s (LSOpen -1712) while Mail is still finding it.
 */
export async function openMailMessage(target: MailTarget): Promise<{ messageId: string; url: string }> {
    const messageId =
        "messageId" in target ? normalizeMessageId(target.messageId) : await messageIdForRow(target.rowid);

    if (messageId.length === 0) {
        throw new Error("empty Message-ID");
    }

    const url = mailMessageUrl(messageId);
    const proc = Bun.spawn(["open", "-a", "Mail", url], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    logger.debug({ url, code }, "macos mail: open -a Mail");

    if (code !== 0) {
        throw new Error(`Mail did not take ${url}: ${stderr.trim() || `exit ${code}`}`);
    }

    return { messageId, url };
}

async function messageIdForRow(rowid: number): Promise<string> {
    const emlx = await EmlxBodyExtractor.create();

    try {
        const parts = await emlx.getBodyParts(rowid);

        // No .emlx indexed means a summary-only fallback with an empty raw: the file is missing, not the header.
        if (!parts?.raw) {
            throw new Error(`message ${rowid} has no message file on disk`);
        }

        const id = messageIdFromRaw(parts.raw);

        if (!id) {
            throw new Error(`message ${rowid} has no Message-ID header`);
        }

        return id;
    } finally {
        emlx.dispose();
    }
}
