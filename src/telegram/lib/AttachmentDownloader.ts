import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { TGClient } from "./TGClient";
import type { AttachmentLocator } from "./types";

const DEFAULT_ATTACHMENTS_DIR = join(homedir(), ".genesis-tools", "telegram", "attachments");

export interface DownloadAttachmentOptions {
    outputPath?: string;
}

export interface DownloadAttachmentResult {
    outputPath: string;
    bytes: number;
}

export class AttachmentDownloader {
    async downloadByLocator(
        client: TGClient,
        store: TelegramHistoryStore,
        locator: AttachmentLocator,
        options: DownloadAttachmentOptions = {}
    ): Promise<DownloadAttachmentResult> {
        const attachment = store.getAttachment(locator);

        if (!attachment) {
            throw new Error(
                `Attachment not found for ${locator.chatId}:${locator.messageId}:${locator.attachmentIndex}`
            );
        }

        const message = await client.getMessageById(locator.chatId, locator.messageId);

        if (!message || !message.media) {
            throw new Error(`Telegram message ${locator.messageId} has no downloadable media`);
        }

        const baseName = attachment.file_name ?? `${locator.messageId}-${locator.attachmentIndex}`;
        const fallbackPath = join(DEFAULT_ATTACHMENTS_DIR, locator.chatId, baseName);
        const outputPath = options.outputPath ?? fallbackPath;
        const outputDir = dirname(outputPath);

        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        const downloaded = await client.downloadMedia(message, {
            outputFile: outputPath,
        });

        if (downloaded === undefined) {
            throw new Error("Telegram client returned no data while downloading media");
        }

        if (Buffer.isBuffer(downloaded)) {
            store.markAttachmentDownloaded(locator, outputPath, downloaded);

            return {
                outputPath,
                bytes: downloaded.byteLength,
            };
        }

        const fileBytes = readFileSync(downloaded);
        store.markAttachmentDownloaded(locator, downloaded, fileBytes);

        return {
            outputPath: downloaded,
            bytes: fileBytes.byteLength,
        };
    }
}

export const attachmentDownloader = new AttachmentDownloader();
