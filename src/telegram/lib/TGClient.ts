import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { DeletedMessage, type DeletedMessageEvent } from "telegram/events/DeletedMessage";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage";
import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage";
import { StringSession } from "telegram/sessions";
import type { Dialog } from "telegram/tl/custom/dialog";
import type { TelegramToolConfig } from "./TelegramToolConfig";
import { DEFAULTS } from "./types";

export interface AuthCallbacks {
    phoneNumber: () => Promise<string>;
    phoneCode: () => Promise<string>;
    password: () => Promise<string>;
}

export interface DownloadMediaOptions {
    outputFile?: string;
    thumb?: number | Api.TypePhotoSize;
}

export class TGClient {
    private client: TelegramClient;

    constructor(apiId: number, apiHash: string, session = "") {
        this.client = new TelegramClient(new StringSession(session), apiId, apiHash, {
            connectionRetries: DEFAULTS.connectionRetries,
        });
    }

    static fromConfig(config: TelegramToolConfig): TGClient {
        return new TGClient(config.getApiId(), config.getApiHash(), config.getSession());
    }

    async startWithAuth(callbacks: AuthCallbacks): Promise<void> {
        await this.client.start({
            phoneNumber: callbacks.phoneNumber,
            phoneCode: callbacks.phoneCode,
            password: callbacks.password,
            onError: (err) => console.error("Auth error:", err),
        });
    }

    async connect(): Promise<boolean> {
        await this.client.connect();
        return this.client.checkAuthorization();
    }

    async disconnect(): Promise<void> {
        await this.client.disconnect();
    }

    getSessionString(): string {
        return (this.client.session as StringSession).save();
    }

    async getMe(): Promise<Api.User> {
        return this.client.getMe() as Promise<Api.User>;
    }

    async getDialogs(limit = 100): Promise<Dialog[]> {
        return this.client.getDialogs({ limit });
    }

    async sendMessage(userId: string, text: string): Promise<Api.Message> {
        return (await this.client.sendMessage(userId, { message: text })) as Api.Message;
    }

    async sendTyping(userId: string): Promise<void> {
        const peer = await this.client.getInputEntity(userId);

        await this.client.invoke(
            new Api.messages.SetTyping({
                peer,
                action: new Api.SendMessageTypingAction(),
            })
        );
    }

    startTypingLoop(userId: string): { stop: () => void } {
        let stopped = false;

        const tick = async () => {
            if (stopped) {
                return;
            }

            try {
                await this.sendTyping(userId);
            } catch {
                // ignore typing errors
            }
        };

        tick();
        const interval = setInterval(tick, DEFAULTS.typingIntervalMs);

        return {
            stop: () => {
                stopped = true;
                clearInterval(interval);
            },
        };
    }

    onNewMessage(handler: (event: NewMessageEvent) => Promise<void>): void {
        this.client.addEventHandler(handler, new NewMessage({}));
    }

    onEditedMessage(handler: (event: EditedMessageEvent) => Promise<void>): void {
        this.client.addEventHandler(handler, new EditedMessage({}));
    }

    onDeletedMessage(handler: (event: DeletedMessageEvent) => Promise<void>): void {
        this.client.addEventHandler(handler, new DeletedMessage({}));
    }

    async downloadMedia(
        messageOrMedia: Api.Message | Api.TypeMessageMedia,
        options: DownloadMediaOptions = {}
    ): Promise<string | Buffer | undefined> {
        return this.client.downloadMedia(messageOrMedia, {
            outputFile: options.outputFile,
            thumb: options.thumb,
        });
    }

    get raw(): TelegramClient {
        return this.client;
    }

    // ── History methods ──────────────────────────────────────────────

    async *getMessages(
        chatId: string,
        options: {
            limit?: number;
            offsetDate?: number;
            minId?: number;
            maxId?: number;
            reverse?: boolean;
        } = {}
    ): AsyncGenerator<Api.Message> {
        for await (const message of this.client.iterMessages(chatId, {
            limit: options.limit,
            offsetDate: options.offsetDate,
            minId: options.minId,
            maxId: options.maxId,
            reverse: options.reverse,
        })) {
            if (message.className !== "Message") {
                continue;
            }

            yield message;
        }
    }

    async getMessageCount(chatId: string): Promise<number> {
        const result = await this.client.invoke(
            new Api.messages.Search({
                peer: await this.client.getInputEntity(chatId),
                q: "",
                filter: new Api.InputMessagesFilterEmpty(),
                minDate: 0,
                maxDate: 0,
                offsetId: 0,
                addOffset: 0,
                limit: 0,
                maxId: 0,
                minId: 0,
                hash: bigInt(0),
            })
        );

        if ("count" in result) {
            return result.count;
        }

        return 0;
    }

    async getMessageById(chatId: string, messageId: number): Promise<Api.Message | null> {
        for await (const message of this.getMessages(chatId, {
            minId: Math.max(0, messageId - 1),
            maxId: messageId + 1,
            limit: 10,
        })) {
            if (message.id === messageId) {
                return message;
            }
        }

        return null;
    }
}
