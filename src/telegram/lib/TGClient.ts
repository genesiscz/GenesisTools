import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import { StringSession } from "telegram/sessions";
import type { Dialog } from "telegram/tl/custom/dialog";
import type { TelegramToolConfig } from "./TelegramToolConfig";
import { DEFAULTS } from "./types";

export interface AuthCallbacks {
    phoneNumber: () => Promise<string>;
    phoneCode: () => Promise<string>;
    password: () => Promise<string>;
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

    async sendMessage(userId: string, text: string): Promise<void> {
        await this.client.sendMessage(userId, { message: text });
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

    get raw(): TelegramClient {
        return this.client;
    }

    // ── History methods (Phase 2 preparation) ──────────────────────────

    async *getMessages(
        userId: string,
        options: { limit?: number; offsetDate?: number; minId?: number; maxId?: number } = {}
    ): AsyncGenerator<Api.Message> {
        for await (const message of this.client.iterMessages(userId, {
            limit: options.limit,
            offsetDate: options.offsetDate,
            minId: options.minId,
            maxId: options.maxId,
        })) {
            yield message;
        }
    }

    async getMessageCount(userId: string): Promise<number> {
        const result = await this.client.invoke(
            new Api.messages.Search({
                peer: await this.client.getInputEntity(userId),
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
}
