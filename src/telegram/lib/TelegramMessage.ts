import type { Api } from "telegram";

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

    // ── Serialization (Phase 2 preparation) ────────────────────────────

    toJSON(): SerializedMessage {
        return {
            id: this.id,
            senderId: this.senderId,
            text: this.text,
            mediaDescription: this.mediaDescription,
            isOutgoing: this.isOutgoing,
            date: this.date.toISOString(),
            dateUnix: this.message.date,
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
}
