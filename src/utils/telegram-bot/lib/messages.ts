import { telegramBotStorage } from "./config";
import type { ParseMode } from "./types";

/** Where one posted message lives, so another process can edit it later. */
export interface PostedMessage {
    chat: number;
    message: number;
    /** Epoch ms of the post. */
    at: number;
}

type MessageMemory = Record<string, PostedMessage>;

/** Cache file under `~/.genesis-tools/telegram-bot/cache/`. A notice is posted in one process and retracted in another. */
const MEMORY_FILE = "messages.json";

/** A notice older than this is forgotten on the next write: its decision or alert has long stopped mattering. */
export const MESSAGE_MEMORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function pruned(memory: MessageMemory | null, now: number): MessageMemory {
    const kept: MessageMemory = {};

    for (const [id, posted] of Object.entries(memory ?? {})) {
        if (now - posted.at < MESSAGE_MEMORY_TTL_MS) {
            kept[id] = posted;
        }
    }

    return kept;
}

export async function rememberMessage(noticeId: string, posted: PostedMessage): Promise<void> {
    await telegramBotStorage().atomicUpdate<MessageMemory>(MEMORY_FILE, (memory) => ({
        ...pruned(memory, posted.at),
        [noticeId]: posted,
    }));
}

/** The message a notice was posted as, or null when it was never posted, or was forgotten. */
export async function recallMessage(noticeId: string, now = Date.now()): Promise<PostedMessage | null> {
    const memory = await telegramBotStorage().getCacheFile<MessageMemory>(MEMORY_FILE, "1000 days");
    const posted = memory?.[noticeId];
    return posted && now - posted.at < MESSAGE_MEMORY_TTL_MS ? posted : null;
}

export async function forgetMessage(noticeId: string, now = Date.now()): Promise<void> {
    await telegramBotStorage().atomicUpdate<MessageMemory>(MEMORY_FILE, (memory) => {
        const kept = pruned(memory, now);
        delete kept[noticeId];
        return kept;
    });
}

/** One inline button. `data` is at most 64 bytes (Telegram's limit), `<prefix>:<payload>` for the callback router. */
export interface TelegramButton {
    text: string;
    data: string;
}

interface InlineMarkup {
    inline_keyboard: { text: string; callback_data: string }[][];
}

interface MessageOptions {
    parse_mode?: ParseMode;
    reply_markup?: InlineMarkup;
}

/**
 * The part of the Bot API a post, an edit and a button press need. grammY's `Api` satisfies it; tests pass an
 * in-memory fake, so no test ever reaches Telegram.
 */
export interface TelegramMessagesApi {
    sendMessage(chatId: number, text: string, other?: MessageOptions): Promise<{ message_id: number }>;
    editMessageText(chatId: number, messageId: number, text: string, other?: MessageOptions): Promise<unknown>;
    answerCallbackQuery(callbackQueryId: string, other?: { text?: string }): Promise<unknown>;
}

function markup(buttons: readonly (readonly TelegramButton[])[] | undefined): InlineMarkup | undefined {
    if (!buttons?.length) {
        return undefined;
    }

    return {
        inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))),
    };
}

/**
 * Posts one message and returns where it lives. With `noticeId` the message is remembered, so a later
 * `retractTelegramNotice` in any process can edit it.
 */
export async function postTelegramMessage({
    api,
    chatId,
    text,
    parseMode,
    buttons,
    noticeId,
    now = Date.now(),
}: {
    api: TelegramMessagesApi;
    chatId: number;
    text: string;
    parseMode?: ParseMode;
    buttons?: readonly (readonly TelegramButton[])[];
    noticeId?: string;
    now?: number;
}): Promise<PostedMessage> {
    const reply_markup = markup(buttons);
    const sent = await api.sendMessage(chatId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(reply_markup ? { reply_markup } : {}),
    });
    const posted = { chat: chatId, message: sent.message_id, at: now };

    if (noticeId) {
        await rememberMessage(noticeId, posted);
    }

    return posted;
}

/**
 * Edits a remembered notice to `text` and drops its buttons, then forgets it. False when the notice was never posted
 * (or was forgotten): there is nothing to edit.
 */
export async function retractTelegramNotice({
    api,
    noticeId,
    text,
    parseMode,
}: {
    api: TelegramMessagesApi;
    noticeId: string;
    text: string;
    parseMode?: ParseMode;
}): Promise<boolean> {
    const posted = await recallMessage(noticeId);

    if (!posted) {
        return false;
    }

    await api.editMessageText(posted.chat, posted.message, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        reply_markup: { inline_keyboard: [] },
    });
    await forgetMessage(noticeId);
    return true;
}
