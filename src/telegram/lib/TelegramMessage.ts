import type { Api } from "telegram";

export interface AttachmentDescriptor {
    index: number;
    kind: "photo" | "document" | "audio" | "video" | "voice" | "sticker" | "gif" | "file";
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    telegramFileId?: string;
    thumbCount: number;
}

function getFileNameFromAttributes(attributes: Api.TypeDocumentAttribute[] | undefined): string | undefined {
    if (!attributes) {
        return undefined;
    }

    for (const attr of attributes) {
        if (attr.className === "DocumentAttributeFilename") {
            const named = attr as Api.DocumentAttributeFilename;
            return named.fileName;
        }
    }

    return undefined;
}

export class TelegramMessage {
    constructor(private message: Api.Message) {}

    get id(): number {
        return this.message.id;
    }

    get text(): string {
        return this.message.text ?? "";
    }

    get isPrivate(): boolean {
        return this.message.isPrivate ?? false;
    }

    get isOutgoing(): boolean {
        return this.message.out ?? false;
    }

    get senderId(): string | undefined {
        return this.message.senderId?.toString();
    }

    get chatId(): string | undefined {
        if (this.message.chatId) {
            return this.message.chatId.toString();
        }

        const peerId = this.message.peerId;

        if (!peerId) {
            return undefined;
        }

        if ("userId" in peerId && peerId.userId) {
            return peerId.userId.toString();
        }

        if ("chatId" in peerId && peerId.chatId) {
            return peerId.chatId.toString();
        }

        if ("channelId" in peerId && peerId.channelId) {
            return peerId.channelId.toString();
        }

        return undefined;
    }

    get date(): Date {
        return new Date(this.message.date * 1000);
    }

    get hasText(): boolean {
        return !!this.text;
    }

    get hasMedia(): boolean {
        return !!this.message.media;
    }

    get raw(): Api.Message {
        return this.message;
    }

    get preview(): string {
        if (this.text.length > 80) {
            return `${this.text.slice(0, 80)}...`;
        }

        return this.text || this.mediaDescription || "(empty)";
    }

    get contentForLLM(): string {
        if (this.mediaDescription && this.text) {
            return `${this.mediaDescription}: ${this.text}`;
        }

        return this.text || this.mediaDescription || "";
    }

    get editedDateUnix(): number | undefined {
        return this.message.editDate;
    }

    get replyToMsgId(): number | undefined {
        const reply = this.message.replyTo;

        if (!reply) {
            return undefined;
        }

        if (reply.className !== "MessageReplyHeader") {
            return undefined;
        }

        const header = reply as Api.MessageReplyHeader;

        if (!header.replyToMsgId) {
            return undefined;
        }

        return header.replyToMsgId;
    }

    get mediaDescription(): string | undefined {
        const media = this.message.media;

        if (!media) {
            return undefined;
        }

        const name = media.className;

        if (name === "MessageMediaPhoto") {
            return "a photo";
        }

        if (name === "MessageMediaGeo" || name === "MessageMediaGeoLive") {
            return "a location";
        }

        if (name === "MessageMediaContact") {
            return "a contact card";
        }

        if (name === "MessageMediaPoll") {
            return "a poll";
        }

        if (name === "MessageMediaDice") {
            return "a dice/emoji game";
        }

        if (name === "MessageMediaDocument") {
            return this.describeDocument(media as Api.MessageMediaDocument);
        }

        return undefined;
    }

    get attachments(): AttachmentDescriptor[] {
        const media = this.message.media;

        if (!media) {
            return [];
        }

        if (media.className === "MessageMediaPhoto") {
            const photoMedia = media as Api.MessageMediaPhoto;
            const photo = photoMedia.photo;
            const thumbCount =
                photo && photo.className === "Photo"
                    ? ((photo as Api.Photo).sizes?.length ?? 0) + ((photo as Api.Photo).videoSizes?.length ?? 0)
                    : 0;

            const fileId = photo && photo.className === "Photo" ? (photo as Api.Photo).id.toString() : undefined;

            return [
                {
                    index: 0,
                    kind: "photo",
                    telegramFileId: fileId,
                    thumbCount,
                },
            ];
        }

        if (media.className === "MessageMediaDocument") {
            const docMedia = media as Api.MessageMediaDocument;
            const doc = docMedia.document;

            if (!doc || doc.className !== "Document") {
                return [
                    {
                        index: 0,
                        kind: "file",
                        thumbCount: 0,
                    },
                ];
            }

            const typedDoc = doc as Api.Document;
            let kind: AttachmentDescriptor["kind"] = "file";

            for (const attr of typedDoc.attributes ?? []) {
                if (attr.className === "DocumentAttributeSticker") {
                    kind = "sticker";
                }

                if (attr.className === "DocumentAttributeAudio") {
                    const audio = attr as Api.DocumentAttributeAudio;
                    if (audio.voice) {
                        kind = "voice";
                    } else {
                        kind = "audio";
                    }
                }

                if (attr.className === "DocumentAttributeVideo") {
                    const video = attr as Api.DocumentAttributeVideo;
                    if (video.roundMessage) {
                        kind = "video";
                    } else {
                        kind = "video";
                    }
                }

                if (attr.className === "DocumentAttributeAnimated") {
                    kind = "gif";
                }
            }

            return [
                {
                    index: 0,
                    kind,
                    mimeType: typedDoc.mimeType,
                    fileName: getFileNameFromAttributes(typedDoc.attributes),
                    fileSize: Number(typedDoc.size),
                    telegramFileId: typedDoc.id.toString(),
                    thumbCount: (typedDoc.thumbs?.length ?? 0) + (typedDoc.videoThumbs?.length ?? 0),
                },
            ];
        }

        return [];
    }

    private describeDocument(media: Api.MessageMediaDocument): string {
        const doc = media.document;

        if (!doc || doc.className === "DocumentEmpty") {
            return "a document";
        }

        const attrs = (doc as Api.Document).attributes ?? [];

        for (const attr of attrs) {
            if (attr.className === "DocumentAttributeSticker") {
                return "a sticker";
            }

            if (attr.className === "DocumentAttributeAudio") {
                return (attr as Api.DocumentAttributeAudio).voice ? "a voice message" : "an audio file";
            }

            if (attr.className === "DocumentAttributeVideo") {
                return (attr as Api.DocumentAttributeVideo).roundMessage ? "a video message" : "a video";
            }

            if (attr.className === "DocumentAttributeAnimated") {
                return "a GIF";
            }
        }

        return "a file";
    }

    toJSON(): SerializedMessage {
        return {
            id: this.id,
            senderId: this.senderId,
            text: this.text,
            mediaDescription: this.mediaDescription,
            isOutgoing: this.isOutgoing,
            date: this.date.toISOString(),
            dateUnix: this.message.date,
            editedDateUnix: this.editedDateUnix,
            replyToMsgId: this.replyToMsgId,
            attachments: this.attachments,
        };
    }
}

export interface SerializedMessage {
    id: number;
    senderId: string | undefined;
    text: string;
    mediaDescription: string | undefined;
    isOutgoing: boolean;
    date: string;
    dateUnix: number;
    editedDateUnix?: number;
    replyToMsgId?: number;
    attachments?: AttachmentDescriptor[];
}
