import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { TGClient } from "./TGClient";

const ATTACHMENTS_BASE = resolve(homedir(), ".genesis-tools/telegram/chats");

export class AttachmentDownloader {
    constructor(
        private client: TGClient,
        private store: TelegramHistoryStore
    ) {}

    async download(
        chatId: string,
        messageId: number,
        attachmentIndex: number,
        outputPath?: string
    ): Promise<{ path: string; size: number; sha256: string }> {
        const attachments = this.store.getAttachments(chatId, messageId);
        const attachment = attachments.find((a) => a.attachment_index === attachmentIndex);

        if (!attachment) {
            throw new Error(`Attachment not found: chat=${chatId} msg=${messageId} idx=${attachmentIndex}`);
        }

        if (attachment.is_downloaded && attachment.local_path && existsSync(attachment.local_path)) {
            return {
                path: attachment.local_path,
                size: attachment.file_size ?? 0,
                sha256: attachment.sha256 ?? "",
            };
        }

        const messages: import("telegram").Api.Message[] = [];

        for await (const msg of this.client.getMessages(chatId, {
            minId: messageId - 1,
            maxId: messageId + 1,
            limit: 1,
        })) {
            if (msg.id === messageId) {
                messages.push(msg);
            }
        }

        if (messages.length === 0 || !messages[0].media) {
            throw new Error(`Message ${messageId} not found or has no media`);
        }

        const dir = outputPath ? resolve(outputPath, "..") : resolve(ATTACHMENTS_BASE, chatId, "attachments");

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const ext = this.guessExtension(attachment.mime_type, attachment.file_name);
        const fileName = outputPath ? resolve(outputPath) : resolve(dir, `${messageId}-${attachmentIndex}${ext}`);

        const buffer = (await this.client.raw.downloadMedia(messages[0].media, {})) as Buffer;

        if (!buffer) {
            throw new Error("Download returned empty buffer");
        }

        await Bun.write(fileName, buffer);

        const hash = createHash("sha256").update(buffer).digest("hex");

        this.store.markAttachmentDownloaded(chatId, messageId, attachmentIndex, fileName, hash);

        return { path: fileName, size: buffer.length, sha256: hash };
    }

    private guessExtension(mimeType: string | null, fileName: string | null): string {
        if (fileName) {
            const dot = fileName.lastIndexOf(".");

            if (dot !== -1) {
                return fileName.slice(dot);
            }
        }

        const mimeMap: Record<string, string> = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/gif": ".gif",
            "video/mp4": ".mp4",
            "audio/ogg": ".ogg",
            "audio/mpeg": ".mp3",
            "application/pdf": ".pdf",
        };

        return mimeMap[mimeType ?? ""] ?? "";
    }
}
