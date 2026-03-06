import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { SerializedMessage } from "./TelegramMessage";

export class AttachmentIndexer {
    indexSerializedMessage(store: TelegramHistoryStore, chatId: string, message: SerializedMessage): void {
        if (!message.attachments || message.attachments.length === 0) {
            return;
        }

        store.upsertAttachments(chatId, message.id, message.attachments);
    }

    indexBatch(store: TelegramHistoryStore, chatId: string, messages: SerializedMessage[]): void {
        for (const message of messages) {
            this.indexSerializedMessage(store, chatId, message);
        }
    }
}

export const attachmentIndexer = new AttachmentIndexer();
