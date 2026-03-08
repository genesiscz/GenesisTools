import type { Api } from "telegram";
import type { UpsertAttachmentInput } from "./types";

export class AttachmentIndexer {
    static extract(chatId: string, message: Api.Message): UpsertAttachmentInput[] {
        if (!message.media) {
            return [];
        }

        const results: UpsertAttachmentInput[] = [];
        const media = message.media;
        const msgId = message.id;

        switch (media.className) {
            case "MessageMediaPhoto": {
                const photoMedia = media as Api.MessageMediaPhoto;
                const photo = photoMedia.photo;

                if (!photo || photo.className === "PhotoEmpty") {
                    break;
                }

                const fullPhoto = photo as Api.Photo;
                const largestSize = fullPhoto.sizes?.at(-1);
                const fileSize = largestSize && "size" in largestSize ? (largestSize as Api.PhotoSize).size : null;

                results.push({
                    chat_id: chatId,
                    message_id: msgId,
                    attachment_index: 0,
                    kind: "photo",
                    mime_type: "image/jpeg",
                    file_name: null,
                    file_size: fileSize ?? null,
                    telegram_file_id: fullPhoto.id ? String(fullPhoto.id) : null,
                });
                break;
            }

            case "MessageMediaDocument": {
                const docMedia = media as Api.MessageMediaDocument;
                const doc = docMedia.document;

                if (!doc || doc.className === "DocumentEmpty") {
                    break;
                }

                const fullDoc = doc as Api.Document;
                const attributes = fullDoc.attributes ?? [];
                const kind = AttachmentIndexer.classifyDocument(attributes);
                const fileName = AttachmentIndexer.extractFileName(attributes);

                results.push({
                    chat_id: chatId,
                    message_id: msgId,
                    attachment_index: 0,
                    kind,
                    mime_type: fullDoc.mimeType ?? null,
                    file_name: fileName,
                    file_size: fullDoc.size != null ? Number(fullDoc.size) : null,
                    telegram_file_id: fullDoc.id ? String(fullDoc.id) : null,
                });
                break;
            }

            default:
                break;
        }

        return results;
    }

    private static classifyDocument(attributes: Api.TypeDocumentAttribute[]): string {
        for (const attr of attributes) {
            switch (attr.className) {
                case "DocumentAttributeSticker":
                    return "sticker";
                case "DocumentAttributeAudio":
                    return (attr as Api.DocumentAttributeAudio).voice ? "voice" : "audio";
                case "DocumentAttributeVideo":
                    return (attr as Api.DocumentAttributeVideo).roundMessage ? "video_note" : "video";
                case "DocumentAttributeAnimated":
                    return "animation";
            }
        }

        return "document";
    }

    private static extractFileName(attributes: Api.TypeDocumentAttribute[]): string | null {
        for (const attr of attributes) {
            if (attr.className === "DocumentAttributeFilename") {
                return (attr as Api.DocumentAttributeFilename).fileName ?? null;
            }
        }

        return null;
    }
}
