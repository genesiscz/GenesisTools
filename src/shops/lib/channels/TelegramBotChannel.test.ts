import { describe, expect, it, spyOn } from "bun:test";
import { TelegramBotChannel } from "@app/shops/lib/channels/TelegramBotChannel";
import type { NotificationPayload } from "@app/shops/lib/channels/types";
import { CHANNELS, type NotificationEvent } from "@genesiscz/utils/notifications";
import { telegramChannel } from "@genesiscz/utils/notifications/channels/telegram";
import { createApi } from "@genesiscz/utils/telegram-bot/lib/api";
import { postTelegramMessage } from "@genesiscz/utils/telegram-bot/lib/messages";

const PAYLOAD: NotificationPayload = {
    notification: {
        id: 1,
        user_id: 1,
        favorite_id: 10,
        master_product_id: 20,
        product_id: 30,
        fired_at: "2026-05-08T10:00:00Z",
        reason: "target-price",
        prev_price: 50,
        curr_price: 39.9,
        shop_origin: "rohlik.cz",
        delivered_macos_at: null,
        delivered_web_at: null,
        delivered_telegram_at: null,
        delivery_error: null,
        acknowledged_at: null,
        metadata_json: "{}",
    },
    title: "Ritter Sport — 39.9 CZK",
    body: "Best price on rohlík.",
    detailUrl: "/master/20",
    buyUrl: "https://www.rohlik.cz/30",
};

interface SendCall {
    event: NotificationEvent;
    target: { botToken: string; chatId: string };
}

function makeChannel(args: { chatId?: string; ok?: boolean }) {
    const calls: SendCall[] = [];
    const channel = new TelegramBotChannel({
        chatId: args.chatId ?? "123",
        botToken: "123:abc",
        post: async (event, target) => {
            calls.push({ event, target });
            return args.ok === false ? { ok: false } : { ok: true };
        },
    });
    return { channel, calls };
}

describe("TelegramBotChannel", () => {
    it("uses the shared bot API root for shops and retractions", async () => {
        const paths: string[] = [];
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch(request) {
                paths.push(new URL(request.url).pathname);
                return Response.json({
                    ok: true,
                    result: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, text: "notice" },
                });
            },
        });
        const apiRoot = `http://127.0.0.1:${server.port}`;
        const post = spyOn(CHANNELS.telegram, "post").mockImplementation((event, config) => {
            if (config.apiRoot !== apiRoot) {
                throw new Error("not the test server");
            }
            return Promise.resolve({ ok: true });
        });
        try {
            const bot = { botToken: "123:abc", chats: { commands: 42 }, configuredAt: "2026-01-01", apiRoot };
            const channel = TelegramBotChannel.fromEnv({}, bot);
            expect((await channel!.dispatch(PAYLOAD)).delivered).toBe(true);
            const config = { enabled: true, botToken: bot.botToken, chatId: "42", apiRoot };
            await postTelegramMessage({
                api: createApi(bot.botToken, apiRoot),
                chatId: 42,
                text: "hello",
                noticeId: "api-root-test",
            });
            expect(await telegramChannel.retract("api-root-test", config)).toBe(true);
            expect(post.mock.calls[0][1].apiRoot).toBe(apiRoot);
            expect(paths.map((path) => path.split("/").at(-1))).toEqual(["sendMessage", "editMessageText"]);
        } finally {
            post.mockRestore();
            server.stop(true);
        }
    });
    it("available is true when constructed with chatId+client", () => {
        const { channel } = makeChannel({});
        expect(channel.available()).toBe(true);
    });

    it("fromEnv returns null when token or chatId missing", () => {
        expect(TelegramBotChannel.fromEnv({})).toBeNull();
        expect(TelegramBotChannel.fromEnv({ TELEGRAM_BOT_TOKEN: "x" })).toBeNull();
        expect(TelegramBotChannel.fromEnv({ TELEGRAM_CHAT_ID: "x" })).toBeNull();
    });

    it("fromEnv returns a channel when both env vars are set", () => {
        const ch = TelegramBotChannel.fromEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "999" });
        expect(ch).not.toBeNull();
        expect(ch?.available()).toBe(true);
    });

    it("dispatch sends a text containing title + url to the configured chatId", async () => {
        const { channel, calls } = makeChannel({ chatId: "555" });
        const result = await channel.dispatch(PAYLOAD);
        expect(result).toEqual({ channel: "telegram", delivered: true });
        expect(calls[0].target).toEqual({ botToken: "123:abc", chatId: "555" });
        expect(calls[0].event.title).toContain("Ritter Sport");
        expect(calls[0].event.message).toContain("https://www.rohlik.cz/30");
    });

    it("dispatch returns delivered:false + error on send failure", async () => {
        const { channel } = makeChannel({ ok: false });
        const result = await channel.dispatch(PAYLOAD);
        expect(result.delivered).toBe(false);
        expect(result.error).toContain("did not accept");
    });
});
