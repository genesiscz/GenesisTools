import type { TelegramMessagesApi } from "./messages";

/** One message as the fake Bot API holds it. */
export interface FakeTelegramMessage {
    chat: number;
    message: number;
    text: string;
    parseMode?: string;
    buttons: { text: string; data: string }[][];
}

/**
 * An in-memory Bot API for tests: it keeps every sent message, applies edits and records answered presses. No test
 * reaches Telegram through it, and no real chat id or token is needed.
 */
export class FakeTelegramMessagesApi implements TelegramMessagesApi {
    readonly messages: FakeTelegramMessage[] = [];
    readonly answered: { id: string; text?: string }[] = [];
    private nextId = 1;

    async sendMessage(
        chatId: number,
        text: string,
        other?: { parse_mode?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }
    ): Promise<{ message_id: number }> {
        const message = this.nextId++;
        this.messages.push({
            chat: chatId,
            message,
            text,
            ...(other?.parse_mode ? { parseMode: other.parse_mode } : {}),
            buttons: (other?.reply_markup?.inline_keyboard ?? []).map((row) =>
                row.map((button) => ({ text: button.text, data: button.callback_data }))
            ),
        });
        return { message_id: message };
    }

    async editMessageText(
        chatId: number,
        messageId: number,
        text: string,
        other?: { parse_mode?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }
    ): Promise<true> {
        const found = this.messages.find((entry) => entry.chat === chatId && entry.message === messageId);

        if (!found) {
            throw new Error(`Bad Request: message ${messageId} not found in chat ${chatId}`);
        }

        found.text = text;
        found.parseMode = other?.parse_mode;
        found.buttons = (other?.reply_markup?.inline_keyboard ?? []).map((row) =>
            row.map((button) => ({ text: button.text, data: button.callback_data }))
        );
        return true;
    }

    async answerCallbackQuery(callbackQueryId: string, other?: { text?: string }): Promise<true> {
        this.answered.push({ id: callbackQueryId, ...(other?.text ? { text: other.text } : {}) });
        return true;
    }
}
