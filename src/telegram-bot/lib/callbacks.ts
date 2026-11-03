import { logger } from "@genesiscz/utils/logger";
import type { TelegramMessagesApi } from "@genesiscz/utils/telegram-bot/lib/messages";
import type { ParseMode } from "@genesiscz/utils/telegram-bot/lib/types";
import type { Bot } from "grammy";

const log = logger.child({ component: "telegram-bot:callbacks" });

/** One button press, as the router sees it. `data` is the button's `<prefix>:<payload>`. */
export interface CallbackPress {
    /** Telegram's callback query id. Telegram retries a press with the same id, so it is the idempotency key. */
    id: string;
    data: string;
    chatId: number;
    messageId?: number;
}

/** What the press answers: a short toast on the phone, and optionally a new text for the message (buttons dropped). */
export interface CallbackReply {
    toast?: string;
    edit?: { text: string; parseMode?: ParseMode };
}

export type CallbackHandler = (press: CallbackPress, payload: string) => Promise<CallbackReply>;

export interface CallbackRouter {
    route(press: CallbackPress): Promise<CallbackReply>;
}

/** The prefix is the text before the first `:`. A press without one, or with an unknown one, is answered, not thrown. */
export function createCallbackRouter(routes: Readonly<Record<string, CallbackHandler>>): CallbackRouter {
    return {
        async route(press) {
            const colon = press.data.indexOf(":");
            const prefix = colon < 0 ? "" : press.data.slice(0, colon);
            const handler = Object.hasOwn(routes, prefix) ? routes[prefix] : undefined;

            if (!handler) {
                log.debug({ data: press.data }, "a button press with no route");
                return { toast: "This button is no longer handled." };
            }

            try {
                return await handler(press, press.data.slice(colon + 1));
            } catch (err) {
                log.warn({ err, prefix }, "a button press failed");
                return { toast: "That did not work. Check the hub." };
            }
        },
    };
}

/**
 * Answers the press (Telegram shows a spinner until it is answered) and applies the reply's edit. Kept apart from
 * grammY so a test drives it with an in-memory api.
 */
export async function answerPress({
    api,
    router,
    press,
}: {
    api: TelegramMessagesApi;
    router: CallbackRouter;
    press: CallbackPress;
}): Promise<CallbackReply> {
    const reply = await router.route(press);

    await api.answerCallbackQuery(press.id, reply.toast ? { text: reply.toast } : {}).catch((err: unknown) => {
        log.debug({ err }, "could not answer a button press");
    });

    if (reply.edit && press.messageId !== undefined) {
        await api
            .editMessageText(press.chatId, press.messageId, reply.edit.text, {
                ...(reply.edit.parseMode ? { parse_mode: reply.edit.parseMode } : {}),
                reply_markup: { inline_keyboard: [] },
            })
            .catch((err: unknown) => log.debug({ err }, "could not edit a pressed message"));
    }

    return reply;
}

/** Wires the router into the bot, after the chat allowlist middleware, so a press from another chat never routes. */
export function registerCallbackRouter(bot: Bot, router: CallbackRouter): void {
    bot.on("callback_query:data", async (ctx) => {
        const query = ctx.callbackQuery;
        const chatId = query.message?.chat.id ?? ctx.chat?.id;

        if (chatId === undefined) {
            await ctx.answerCallbackQuery();
            return;
        }

        await answerPress({
            api: ctx.api,
            router,
            press: { id: query.id, data: query.data, chatId, messageId: query.message?.message_id },
        });
    });
}
