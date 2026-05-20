import { logger } from "@app/logger";
import { ApiClient } from "@app/utils/api/ApiClient";

export interface TelegramBotClientConfig {
    token: string;
    timeoutMs?: number;
}

export interface SendMessageArgs {
    chatId: string | number;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    disableWebPagePreview?: boolean;
}

export interface SendMessageResult {
    ok: true;
    message_id: number;
}

interface TgResponseEnvelope<T> {
    ok: boolean;
    description?: string;
    result?: T;
}

const log = logger.child({ component: "TelegramBotClient" });

export class TelegramBotClient {
    private readonly api: ApiClient;

    constructor(config: TelegramBotClientConfig) {
        this.api = new ApiClient({
            baseUrl: `https://api.telegram.org/bot${config.token}`,
            timeoutMs: config.timeoutMs ?? 15_000,
            loggerContext: { component: "TelegramBotClient" },
        });
    }

    static fromEnv(env: Record<string, string | undefined> = process.env): TelegramBotClient | null {
        const token = env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            return null;
        }

        return new TelegramBotClient({ token });
    }

    async sendMessage(args: SendMessageArgs): Promise<SendMessageResult> {
        const body: Record<string, unknown> = {
            chat_id: args.chatId,
            text: args.text,
        };
        if (args.parseMode) {
            body.parse_mode = args.parseMode;
        }

        if (args.disableWebPagePreview) {
            body.disable_web_page_preview = true;
        }

        const envelope = await this.api.post<TgResponseEnvelope<{ message_id: number }>>("/sendMessage", body);
        if (!envelope.ok || !envelope.result) {
            throw new Error(`telegram sendMessage failed: ${envelope.description ?? "unknown"}`);
        }

        log.debug({ chatId: args.chatId, messageId: envelope.result.message_id }, "telegram message sent");
        return { ok: true, message_id: envelope.result.message_id };
    }
}
