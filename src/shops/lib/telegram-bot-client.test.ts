import { afterEach, describe, expect, it } from "bun:test";
import { TelegramBotClient } from "@app/shops/lib/telegram-bot-client";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

describe("TelegramBotClient", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("fromEnv returns null when TELEGRAM_BOT_TOKEN is unset", () => {
        const processEnv = { ...env.getProcessEnv() };
        delete processEnv.TELEGRAM_BOT_TOKEN;
        expect(TelegramBotClient.fromEnv(processEnv)).toBeNull();
    });

    it("fromEnv returns a client when token is set", () => {
        const client = TelegramBotClient.fromEnv({ TELEGRAM_BOT_TOKEN: "123:abc" });
        expect(client).not.toBeNull();
    });

    it("sendMessage POSTs to /bot<token>/sendMessage", async () => {
        const calls: { url: string; body: unknown }[] = [];
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), body: init?.body });
            return new Response(SafeJSON.stringify({ ok: true, result: { message_id: 42 } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as unknown as typeof fetch;

        const client = new TelegramBotClient({ token: "123:abc" });
        const result = await client.sendMessage({ chatId: "100200", text: "hello" });
        expect(result.ok).toBe(true);
        expect(result.message_id).toBe(42);
        expect(calls[0].url).toContain("https://api.telegram.org/bot123:abc/sendMessage");
    });

    it("sendMessage throws on Telegram non-ok response", async () => {
        globalThis.fetch = (async () =>
            new Response(SafeJSON.stringify({ ok: false, description: "chat not found" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            })) as unknown as typeof fetch;
        const client = new TelegramBotClient({ token: "123:abc" });
        await expect(client.sendMessage({ chatId: "x", text: "hi" })).rejects.toThrow(/chat not found/);
    });
});
