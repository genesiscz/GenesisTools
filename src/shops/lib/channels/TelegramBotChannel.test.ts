import { describe, expect, it } from "bun:test";
import { TelegramBotChannel } from "./TelegramBotChannel";
import type { NotificationPayload } from "./types";

const PAYLOAD: NotificationPayload = {
    notification: {
        id: 1,
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
    chatId: string | number;
    text: string;
    parseMode?: string;
}

function makeChannel(args: {
    chatId?: string;
    sendImpl?: (a: SendCall) => Promise<{ ok: true; message_id: number }>;
}) {
    const calls: SendCall[] = [];
    const channel = new TelegramBotChannel({
        chatId: args.chatId ?? "123",
        client: {
            sendMessage: async (a: SendCall) => {
                calls.push(a);
                return args.sendImpl ? args.sendImpl(a) : { ok: true as const, message_id: 1 };
            },
        },
    });
    return { channel, calls };
}

describe("TelegramBotChannel", () => {
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
        expect(calls[0].chatId).toBe("555");
        expect(calls[0].text).toContain("Ritter Sport");
        expect(calls[0].text).toContain("https://www.rohlik.cz/30");
    });

    it("dispatch returns delivered:false + error on send failure", async () => {
        const { channel } = makeChannel({
            sendImpl: async () => {
                throw new Error("401 Unauthorized");
            },
        });
        const result = await channel.dispatch(PAYLOAD);
        expect(result.delivered).toBe(false);
        expect(result.error).toContain("401 Unauthorized");
    });
});
