import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot, handleUpdate } from "@app/telegram-bot/lib/bot";
import { getStorage, loadTelegramConfig, saveTelegramConfig } from "@app/telegram-bot/lib/config";
import { createRateLimiter } from "@app/telegram-bot/lib/security";
import { SafeJSON } from "@genesiscz/utils/json";
import { type SecretStore, secureRef } from "@genesiscz/utils/security";
import type { Update } from "grammy/types";
import { createTelegramApi, describeApiError, maskToken } from "./api";
import {
    createWebhookHandler,
    MAX_WEBHOOK_BODY_BYTES,
    RecentUpdateIds,
    readBodyWithLimit,
    secretMatches,
    WEBHOOK_SECRET_HEADER,
} from "./receiver";
import {
    ensureWebhookSecret,
    generateWebhookSecret,
    hasWebhookSecret,
    rotateWebhookSecret,
    WEBHOOK_SECRET_PATH,
} from "./secret";
import { runWebhookService, type WebhookServiceOptions } from "./service";
import {
    resolveApiRoot,
    resolveWebhookSettings,
    WEBHOOK_ALLOWED_UPDATES,
    WEBHOOK_RECEIVER_PORT,
    WebhookSettingsError,
} from "./settings";
import { applyTunnelChange, type CommandRunner, planTunnelChange } from "./tunnel";

function fakeToken(): string {
    return `${randomInt(100_000, 999_999)}:${randomBytes(24).toString("base64url")}`;
}

function fakeChatId(): number {
    return randomInt(10_000_000, 99_999_999);
}

function messageUpdate(updateId: number, chatId: number, text: string): Update {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private", first_name: "Tester" },
            from: { id: chatId, is_bot: false, first_name: "Tester" },
            text,
            entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
        },
    };
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
    });
}

function memorySecretStore(): SecretStore & { writes: number } {
    const entries = new Map<string, string>();
    const store: SecretStore & { writes: number } = {
        writes: 0,
        async get(path) {
            return entries.get(path);
        },
        getSync(path) {
            return entries.get(path);
        },
        async set(path, value) {
            store.writes += 1;
            entries.set(path, value);
            return secureRef(path);
        },
        async delete(path) {
            return entries.delete(path);
        },
        async deleteIf(path, expected) {
            return entries.get(path) === expected && entries.delete(path);
        },
        async list() {
            return [...entries.keys()];
        },
        async has(path) {
            return entries.has(path);
        },
    };

    return store;
}

describe("secretMatches", () => {
    it("accepts only the exact secret", () => {
        const secret = generateWebhookSecret();

        expect(secretMatches(secret, secret)).toBe(true);
        expect(secretMatches(`${secret}x`, secret)).toBe(false);
        expect(secretMatches(secret.slice(1), secret)).toBe(false);
        expect(secretMatches(generateWebhookSecret(), secret)).toBe(false);
    });

    it("refuses a missing or empty header, and an empty expected secret", () => {
        expect(secretMatches(null, "abc")).toBe(false);
        expect(secretMatches(undefined, "abc")).toBe(false);
        expect(secretMatches("", "abc")).toBe(false);
        expect(secretMatches("", "")).toBe(false);
    });

    it("generates a 43 character base64url secret from fresh random bytes", () => {
        const first = generateWebhookSecret();

        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(generateWebhookSecret()).not.toBe(first);
    });
});

describe("RecentUpdateIds", () => {
    it("reports a repeat and forgets the oldest id past its capacity", () => {
        const recent = new RecentUpdateIds(2);

        expect(recent.remember(1)).toBe(true);
        expect(recent.remember(1)).toBe(false);
        expect(recent.remember(2)).toBe(true);
        expect(recent.remember(3)).toBe(true);
        expect(recent.remember(2)).toBe(false);
        expect(recent.remember(1)).toBe(true);
    });
});

describe("readBodyWithLimit", () => {
    it("reads a body inside the limit", async () => {
        expect(await readBodyWithLimit(post("/x", '{"a":1}'), 100)).toBe('{"a":1}');
    });

    it("stops a streamed body at the limit when no length was declared", async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(40));
            },
        });
        const request = new Request("http://127.0.0.1/x", { method: "POST", body: stream });

        expect(await readBodyWithLimit(request, 100)).toBeNull();
        expect(pulled).toBeLessThan(10);
    });

    it("refuses on a declared length over the limit without reading", async () => {
        const request = post("/x", "tiny", { "content-length": "999999" });

        expect(await readBodyWithLimit(request, 100)).toBeNull();
    });
});

describe("webhook handler", () => {
    const path = "/hook";
    const secret = generateWebhookSecret();

    function setup(overrides: { maxPending?: number; onUpdate?: (update: Update) => Promise<void> } = {}) {
        const seen: number[] = [];
        const handler = createWebhookHandler({
            secret,
            path,
            maxPending: overrides.maxPending,
            onUpdate:
                overrides.onUpdate ??
                (async (update) => {
                    seen.push(update.update_id);
                }),
        });

        return { handler, seen };
    }

    const withSecret = { [WEBHOOK_SECRET_HEADER]: secret };

    it("answers 404 on another path before it looks at the secret", async () => {
        const { handler } = setup();
        const response = await handler.handle(post("/elsewhere", "{}", withSecret));

        expect(response.status).toBe(404);
    });

    it("answers 401 with an empty body for a missing or wrong secret and never calls the handler", async () => {
        const { handler, seen } = setup();
        const body = updateBody(1);

        const attempts: Array<Record<string, string>> = [
            {},
            { [WEBHOOK_SECRET_HEADER]: "wrong" },
            { [WEBHOOK_SECRET_HEADER]: `${secret}x` },
        ];

        for (const headers of attempts) {
            const response = await handler.handle(post(path, body, headers));

            expect(response.status).toBe(401);
            expect(await response.text()).toBe("");
        }

        await handler.idle();
        expect(seen).toEqual([]);
    });

    it("answers 401 to a GET without the secret, so a probe learns nothing about the method", async () => {
        const { handler } = setup();

        expect((await handler.handle(new Request(`http://127.0.0.1${path}`))).status).toBe(401);
        expect((await handler.handle(new Request(`http://127.0.0.1${path}`, { headers: withSecret }))).status).toBe(
            405
        );
    });

    it("answers 415, 400 and 413 for a body that is not an update", async () => {
        const { handler, seen } = setup();
        const wrongType = new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            headers: { ...withSecret, "content-type": "text/plain" },
            body: updateBody(1),
        });

        expect((await handler.handle(wrongType)).status).toBe(415);
        expect((await handler.handle(post(path, "not json", withSecret))).status).toBe(400);
        expect((await handler.handle(post(path, '{"message":{}}', withSecret))).status).toBe(400);
        expect((await handler.handle(post(path, '{"update_id":"7"}', withSecret))).status).toBe(400);

        const huge = `{"update_id":9,"pad":"${"x".repeat(MAX_WEBHOOK_BODY_BYTES)}"}`;
        expect((await handler.handle(post(path, huge, withSecret))).status).toBe(413);

        await handler.idle();
        expect(seen).toEqual([]);
    });

    it("answers 200 before the handler finishes, then runs it once", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const finished: number[] = [];
        const { handler } = setup({
            onUpdate: async (update) => {
                await gate;
                finished.push(update.update_id);
            },
        });

        const response = await handler.handle(post(path, updateBody(5), withSecret));

        expect(response.status).toBe(200);
        expect(finished).toEqual([]);

        release();
        await handler.idle();
        expect(finished).toEqual([5]);
    });

    it("handles a repeated update_id once", async () => {
        const { handler, seen } = setup();

        expect((await handler.handle(post(path, updateBody(11), withSecret))).status).toBe(200);
        expect((await handler.handle(post(path, updateBody(11), withSecret))).status).toBe(200);
        await handler.idle();

        expect(seen).toEqual([11]);
    });

    it("handles requests that finish one after another in order and asks Telegram to retry past the pending limit, without remembering that update", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const order: number[] = [];
        const { handler } = setup({
            maxPending: 2,
            onUpdate: async (update) => {
                await gate;
                order.push(update.update_id);
            },
        });

        expect((await handler.handle(post(path, updateBody(21), withSecret))).status).toBe(200);
        expect((await handler.handle(post(path, updateBody(22), withSecret))).status).toBe(200);
        const refused = await handler.handle(post(path, updateBody(23), withSecret));
        expect(refused.status).toBe(503);
        expect(refused.headers.get("retry-after")).toBe("5");

        release();
        await handler.idle();
        expect((await handler.handle(post(path, updateBody(23), withSecret))).status).toBe(200);
        await handler.idle();

        expect(order).toEqual([21, 22, 23]);
    });

    it("handles updates one at a time in the order their bodies finish, so a slow upload is overtaken", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const started: number[] = [];
        const { handler } = setup({
            onUpdate: async (update) => {
                started.push(update.update_id);
                await gate;
            },
        });
        let finishSlowBody: (text: string) => void = () => {};
        const slowBody = new ReadableStream<Uint8Array>({
            start(controller) {
                finishSlowBody = (text) => {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                };
            },
        });
        const slow = new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...withSecret },
            body: slowBody,
        });

        const slowResponse = handler.handle(slow);
        expect((await handler.handle(post(path, updateBody(2), withSecret))).status).toBe(200);
        finishSlowBody(updateBody(1));
        expect((await slowResponse).status).toBe(200);
        expect(started).toEqual([2]);

        release();
        await handler.idle();
        expect(started).toEqual([2, 1]);
    });

    it("survives a handler that throws and keeps serving", async () => {
        const seen: number[] = [];
        const { handler } = setup({
            onUpdate: async (update) => {
                if (update.update_id === 31) {
                    throw new Error("boom");
                }

                seen.push(update.update_id);
            },
        });

        await handler.handle(post(path, updateBody(31), withSecret));
        await handler.handle(post(path, updateBody(32), withSecret));
        await handler.idle();

        expect(seen).toEqual([32]);
    });
});

function updateBody(updateId: number): string {
    return `{"update_id":${updateId}}`;
}

describe("webhook settings", () => {
    it("asks for a URL once, naming the command that stores it", () => {
        expect(() => resolveWebhookSettings({})).toThrow(/telegram-bot webhook set --url/);
    });

    it("takes host and path from the URL and the port from the registry", () => {
        const settings = resolveWebhookSettings({ url: "https://bot.example.test/hooks/tg" });

        expect(settings).toEqual({
            url: "https://bot.example.test/hooks/tg",
            hostname: "bot.example.test",
            path: "/hooks/tg",
            port: WEBHOOK_RECEIVER_PORT,
        });
    });

    it("prefers the flag over the stored URL", () => {
        const settings = resolveWebhookSettings({
            url: "https://a.example.test/x",
            configuredUrl: "https://b.example.test/y",
        });

        expect(settings.hostname).toBe("a.example.test");
    });

    it("refuses http, credentials, a query, a fragment, a mismatched path and a bad port", () => {
        const refuse = (input: Parameters<typeof resolveWebhookSettings>[0]) =>
            expect(() => resolveWebhookSettings(input)).toThrow(WebhookSettingsError);

        refuse({ url: "http://bot.example.test/x" });
        refuse({ url: "https://user:pw@bot.example.test/x" });
        refuse({ url: "https://bot.example.test/x?secret=1" });
        refuse({ url: "https://bot.example.test/x#frag" });
        refuse({ url: "https://bot.example.test/x", path: "/y" });
        refuse({ url: "https://bot.example.test/x", port: 0 });
        refuse({ url: "https://bot.example.test/x", port: 70_000 });
        refuse({ url: "not a url" });
        expect(resolveWebhookSettings({ url: "https://bot.example.test/x", path: "/x" }).path).toBe("/x");
    });

    it("limits the Bot API root to https, or http on loopback, and strips a trailing slash", () => {
        expect(resolveApiRoot(undefined)).toBeUndefined();
        expect(resolveApiRoot("https://api.example.test/")).toBe("https://api.example.test");
        expect(resolveApiRoot("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
        expect(() => resolveApiRoot("http://api.example.test")).toThrow(WebhookSettingsError);
        expect(() => resolveApiRoot("nonsense")).toThrow(WebhookSettingsError);
    });

    it("lists only the update kinds the handlers read", () => {
        expect([...WEBHOOK_ALLOWED_UPDATES]).toEqual(["message"]);
    });
});

describe("token masking", () => {
    it("hides the token, the bot path form and a bare token shape", () => {
        const token = fakeToken();
        const other = fakeToken();
        const text = `failed: https://api.example.test/bot${token}/getWebhookInfo and ${token} and ${other}`;
        const masked = maskToken(text, token);

        expect(masked).not.toContain(token);
        expect(masked).not.toContain(other);
        expect(masked).toContain("bot***");
    });

    it("masks an error message", () => {
        const token = fakeToken();

        expect(describeApiError(new Error(`bad ${token}`), token)).toBe("bad ***");
        expect(describeApiError("plain", token)).toBe("plain");
    });
});

describe("rate limiter", () => {
    it("holds a command to its cooldown and the whole bot to its window, on the clock it is given", () => {
        let now = 1_000;
        const limiter = createRateLimiter(() => now);

        expect(limiter.check("tools").allowed).toBe(true);
        expect(limiter.check("tools")).toEqual({ allowed: false, retryAfterMs: 5_000 });
        now += 5_000;
        expect(limiter.check("tools").allowed).toBe(true);

        for (let i = 0; i < 18; i++) {
            expect(limiter.check("help").allowed).toBe(true);
        }

        expect(limiter.check("help").allowed).toBe(false);
        now += 60_000;
        expect(limiter.check("help").allowed).toBe(true);
    });
});

describe("telegram config file", () => {
    it("is created at 0600, so no write publishes the bot token at the umask default", async () => {
        const previous = process.umask(0o022);

        try {
            const storage = getStorage();
            await storage.setConfig({ botToken: fakeToken(), chatId: fakeChatId(), configuredAt: "2026-01-01" });
            expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o600);

            chmodSync(storage.getConfigPath(), 0o644);
            await saveTelegramConfig({ botToken: fakeToken(), chatId: fakeChatId(), configuredAt: "2026-01-01" });
            expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o600);
        } finally {
            process.umask(previous);
        }
    });
});

describe("webhook secret", () => {
    it("is minted once, kept in the vault, and the config holds only a pointer", async () => {
        const store = memorySecretStore();
        await saveTelegramConfig({ botToken: fakeToken(), chatId: fakeChatId(), configuredAt: "2026-01-01" });

        expect(await hasWebhookSecret(store)).toBe(false);
        expect(store.writes).toBe(0);

        const first = await ensureWebhookSecret({ store });
        const again = await ensureWebhookSecret({ store });

        expect(again).toBe(first);
        expect(store.writes).toBe(1);
        expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(first);
        expect(await hasWebhookSecret(store)).toBe(true);

        const config = await loadTelegramConfig();
        expect(config?.webhook?.secret).toEqual({ type: "secure", path: WEBHOOK_SECRET_PATH });
        expect(SafeJSON.stringify(config)).not.toContain(first);
    });

    it("rotates on request, and a status check by itself writes nothing", async () => {
        const store = memorySecretStore();
        await saveTelegramConfig({ botToken: fakeToken(), chatId: fakeChatId(), configuredAt: "2026-01-01" });

        const first = await ensureWebhookSecret({ store });
        await hasWebhookSecret(store);
        expect(store.writes).toBe(1);

        const rotated = await rotateWebhookSecret({ store, register: async () => {} });

        expect(rotated).not.toBe(first);
        expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(rotated);
    });
});

interface FakeTelegram {
    apiRoot: string;
    calls: Array<{ method: string; body: Record<string, unknown> }>;
    /** Settles once the fake has been asked for `method`, whether that already happened or not. */
    seen(method: string): Promise<void>;
    stop(): Promise<void>;
}

function startFakeTelegram(options: { rejects?: string } = {}): FakeTelegram {
    const calls: FakeTelegram["calls"] = [];
    const waiting = new Map<string, Array<() => void>>();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const method = new URL(request.url).pathname.split("/").pop() ?? "";
            const body: Record<string, unknown> = await request.json().catch(() => ({}));
            calls.push({ method, body });

            for (const wake of waiting.get(method) ?? []) {
                wake();
            }

            if (method === options.rejects) {
                return Response.json(
                    { ok: false, error_code: 400, description: "Bad Request: bad webhook: HTTPS url must be provided" },
                    { status: 400 }
                );
            }

            return Response.json({ ok: true, result: resultFor(method, body) });
        },
    });

    return {
        apiRoot: `http://127.0.0.1:${server.port}`,
        calls,
        seen: (method) =>
            new Promise<void>((resolve) => {
                if (calls.some((call) => call.method === method)) {
                    resolve();
                    return;
                }

                waiting.set(method, [...(waiting.get(method) ?? []), resolve]);
            }),
        stop: () => server.stop(true),
    };
}

function resultFor(method: string, body: Record<string, unknown>): unknown {
    switch (method) {
        case "getMe":
            return { id: 1, is_bot: true, first_name: "Fake", username: "fake_test_bot", can_join_groups: true };
        case "sendMessage":
            return {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                chat: { id: body.chat_id, type: "private" },
                text: body.text,
            };
        case "getUpdates":
            return [];
        default:
            return true;
    }
}

describe("webhook secret rotation", () => {
    const url = "https://bot.example.test/hook";
    /** The file lock polls every 50 ms, so a registration this long gives a second rotation time to try and wait. */
    const LOCK_POLL_MS = 50;

    async function rotationSetup(options: { rejects?: string } = {}) {
        const store = memorySecretStore();
        await saveTelegramConfig({ botToken: fakeToken(), chatId: fakeChatId(), configuredAt: "2026-01-01" });
        const old = await ensureWebhookSecret({ store });
        const fake = startFakeTelegram(options);
        const api = createTelegramApi({ botToken: fakeToken(), apiRoot: fake.apiRoot });
        const register = (secret: string) => api.setWebhook(url, { secret_token: secret });

        return { store, old, fake, register };
    }

    it("hands the new secret to Telegram first and stores it only once Telegram accepted it", async () => {
        const { store, old, fake, register } = await rotationSetup();
        let storedWhileRegistering: string | undefined;

        const rotated = await rotateWebhookSecret({
            store,
            register: async (secret) => {
                storedWhileRegistering = await store.get(WEBHOOK_SECRET_PATH);
                await register(secret);
            },
        });
        await fake.stop();

        expect(storedWhileRegistering).toBe(old);
        expect(fake.calls.filter((call) => call.method === "setWebhook").map((call) => call.body.secret_token)).toEqual(
            [rotated]
        );
        expect(rotated).not.toBe(old);
        expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(rotated);
        expect(store.writes).toBe(2);
    });

    for (const failure of ["a refusal", "an unreachable Telegram"]) {
        it(`keeps the old secret in the vault and the config after ${failure}`, async () => {
            const { store, old, fake, register } = await rotationSetup({ rejects: "setWebhook" });

            if (failure !== "a refusal") {
                await fake.stop();
            }

            await expect(rotateWebhookSecret({ store, register })).rejects.toThrow();
            await fake.stop();

            expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(old);
            expect(store.writes).toBe(1);
            expect((await loadTelegramConfig())?.webhook?.secret).toEqual(secureRef(WEBHOOK_SECRET_PATH));
            expect(await ensureWebhookSecret({ store })).toBe(old);
            expect(fake.calls.some((call) => call.method === "setWebhook")).toBe(failure === "a refusal");
        });
    }

    it("says Telegram has the new secret when only the store failed, and a later rotation repairs it", async () => {
        const { store, old, fake, register } = await rotationSetup();
        const failing: SecretStore = {
            ...store,
            async set() {
                throw new Error("vault is read-only");
            },
        };

        await expect(rotateWebhookSecret({ store: failing, register })).rejects.toThrow(
            /Telegram accepted the new secret but it could not be stored \(vault is read-only\)/
        );
        expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(old);

        const repaired = await rotateWebhookSecret({ store, register });
        await fake.stop();

        expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(repaired);
        expect(fake.calls.at(-1)?.body.secret_token).toBe(repaired);
    });

    it("runs two rotations one after the other, so Telegram and the vault end on the same secret", async () => {
        const { store, old } = await rotationSetup();
        const seen: Array<{ stored: string | undefined; registered: string }> = [];
        const register = async (secret: string) => {
            seen.push({ stored: await store.get(WEBHOOK_SECRET_PATH), registered: secret });
            await Bun.sleep(LOCK_POLL_MS * 2 + 20);
        };

        await Promise.all([rotateWebhookSecret({ store, register }), rotateWebhookSecret({ store, register })]);

        expect(seen).toHaveLength(2);
        expect(seen[0].stored).toBe(old);
        expect(seen[1].stored).toBe(seen[0].registered);
        expect(await store.get(WEBHOOK_SECRET_PATH)).toBe(seen[1].registered);
    });
});

describe("webhook receiver end to end", () => {
    const token = fakeToken();
    const allowedChat = fakeChatId();
    const secret = generateWebhookSecret();
    const path = "/telegram-hook";
    const publicUrl = `https://bot.example.test${path}`;
    const fake = startFakeTelegram();
    const stop = new AbortController();
    let port = 0;
    let idle: () => Promise<void> = async () => {};
    let running: Promise<void>;

    const sent = () => fake.calls.filter((call) => call.method === "sendMessage");
    const send = (update: Update, headers: Record<string, string> = { [WEBHOOK_SECRET_HEADER]: secret }) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: SafeJSON.stringify(update),
        });

    beforeAll(async () => {
        const bot = createBot(token, allowedChat, { apiRoot: fake.apiRoot });
        await bot.init();
        const listening = new Promise<void>((resolve) => {
            running = runWebhookService({
                bot,
                api: createTelegramApi({ botToken: token, apiRoot: fake.apiRoot }),
                secret,
                settings: { url: publicUrl, hostname: "bot.example.test", path, port: 0 },
                deleteOnExit: false,
                signal: stop.signal,
                onListening: (server) => {
                    port = server.port;
                    idle = server.idle;
                    resolve();
                },
            });
        });

        await listening;
        await fake.seen("setWebhook");
    });

    afterAll(async () => {
        stop.abort();
        await running;
        await fake.stop();
    });

    it("registers the public URL with the secret and only the update kinds the handlers use", () => {
        const call = fake.calls.find((entry) => entry.method === "setWebhook");

        expect(call?.body).toEqual({ url: publicUrl, secret_token: secret, allowed_updates: ["message"] });
        expect(fake.calls.some((entry) => entry.method === "deleteWebhook")).toBe(false);
    });

    it("runs the handler for an update with the right secret", async () => {
        const before = sent().length;
        const response = await send(messageUpdate(101, allowedChat, "/help"));
        await idle();

        expect(response.status).toBe(200);
        expect(sent().length).toBe(before + 1);
        expect(String(sent().at(-1)?.body.text)).toContain("Available commands");
        expect(sent().at(-1)?.body.chat_id).toBe(allowedChat);
    });

    it("answers 401 to a wrong or missing secret and runs nothing", async () => {
        const before = sent().length;
        const wrong = await send(messageUpdate(102, allowedChat, "/help"), { [WEBHOOK_SECRET_HEADER]: "wrong" });
        const missing = await send(messageUpdate(103, allowedChat, "/help"), {});
        await idle();

        expect(wrong.status).toBe(401);
        expect(await wrong.text()).toBe("");
        expect(missing.status).toBe(401);
        expect(sent().length).toBe(before);
    });

    it("handles a duplicate update_id once", async () => {
        const before = sent().length;
        await send(messageUpdate(104, allowedChat, "/help"));
        await send(messageUpdate(104, allowedChat, "/help"));
        await idle();

        expect(sent().length).toBe(before + 1);
    });

    it("drops an update from a chat that is not allowed without a reply", async () => {
        const before = sent().length;
        const response = await send(messageUpdate(105, allowedChat + 1, "/help"));
        await idle();

        expect(response.status).toBe(200);
        expect(sent().length).toBe(before);
    });

    it("answers 413 to an oversized body", async () => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", [WEBHOOK_SECRET_HEADER]: secret },
            body: `{"update_id":106,"pad":"${"x".repeat(MAX_WEBHOOK_BODY_BYTES)}"}`,
        });

        expect(response.status).toBe(413);
    });

    it("answers 404 on another path", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/other`, {
            method: "POST",
            headers: { [WEBHOOK_SECRET_HEADER]: secret },
        });

        expect(response.status).toBe(404);
    });
});

describe("bot pipeline", () => {
    it("rate limits a command for an allowed chat and never charges a chat that is not allowed", async () => {
        const fake = startFakeTelegram();
        const checked: string[] = [];
        const bot = createBot(fakeToken(), 42, {
            apiRoot: fake.apiRoot,
            rateLimiter: {
                check(command) {
                    checked.push(command);
                    return { allowed: false, retryAfterMs: 2_500 };
                },
            },
        });
        await bot.init();

        await handleUpdate(bot, messageUpdate(1, 43, "/help"));
        await handleUpdate(bot, messageUpdate(2, 42, "/help"));
        await fake.stop();

        expect(checked).toEqual(["help"]);
        const replies = fake.calls.filter((call) => call.method === "sendMessage");
        expect(replies.map((call) => call.body.text)).toEqual(["Too many requests. Try again in 3s."]);
    });

    it("polling start removes any webhook before it fetches updates", async () => {
        const fake = startFakeTelegram();
        const bot = createBot(fakeToken(), 42, { apiRoot: fake.apiRoot });
        const started = new Promise<void>((resolve) => {
            bot.start({ onStart: () => resolve() }).catch(() => undefined);
        });

        await started;
        await fake.seen("getUpdates");
        await bot.stop();
        await fake.stop();

        const order = fake.calls.map((call) => call.method);
        expect(order.indexOf("deleteWebhook")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("deleteWebhook")).toBeLessThan(order.indexOf("getUpdates"));
    });
});

describe("webhook service lifecycle", () => {
    async function runOnce(deleteOnExit: boolean): Promise<string[]> {
        const fake = startFakeTelegram();
        const token = fakeToken();
        const stop = new AbortController();
        const bot = createBot(token, 42, { apiRoot: fake.apiRoot });
        await bot.init();

        const running = runWebhookService({
            bot,
            api: createTelegramApi({ botToken: token, apiRoot: fake.apiRoot }),
            secret: generateWebhookSecret(),
            settings: { url: "https://bot.example.test/hook", hostname: "bot.example.test", path: "/hook", port: 0 },
            deleteOnExit,
            signal: stop.signal,
        } satisfies WebhookServiceOptions);

        await fake.seen("setWebhook");
        stop.abort();
        await running;
        await fake.stop();

        return fake.calls.map((call) => call.method);
    }

    it("leaves the webhook set on a clean stop, so Telegram queues updates while the bot is down", async () => {
        expect(await runOnce(false)).not.toContain("deleteWebhook");
    });

    it("deletes the webhook on a clean stop when asked to", async () => {
        const methods = await runOnce(true);

        expect(methods.at(-1)).toBe("deleteWebhook");
    });

    it("does not delete a webhook it never managed to set", async () => {
        const fake = startFakeTelegram();
        await fake.stop();
        const token = fakeToken();
        const bot = createBot(token, 42, { apiRoot: fake.apiRoot });

        const outcome = runWebhookService({
            bot,
            api: createTelegramApi({ botToken: token, apiRoot: fake.apiRoot }),
            secret: generateWebhookSecret(),
            settings: { url: "https://bot.example.test/hook", hostname: "bot.example.test", path: "/hook", port: 0 },
            deleteOnExit: true,
            signal: new AbortController().signal,
        });

        await expect(outcome).rejects.toThrow();
        expect(fake.calls.map((call) => call.method)).toEqual([]);
    });
});

const LEGACY_CONFIG = `tunnel: demo-tunnel
credentials-file: /var/empty/demo.json

ingress:
  # Old webhook listener
  - hostname: bot.example.test
    path: /telegram-webhook
    service: http://127.0.0.1:8787

  # dashboard catch-all
  - hostname: bot.example.test
    service: http://127.0.0.1:3042
  - service: http_status:404
`;

const RULE = { hostname: "bot.example.test", path: "/telegram-webhook", port: WEBHOOK_RECEIVER_PORT };

describe("tunnel change", () => {
    it("plans an anchored rule in place of the old one and shows it as a diff", () => {
        const plan = planTunnelChange({ configPath: "/x/config.yml", before: LEGACY_CONFIG, rule: RULE });

        expect(plan.changed).toBe(true);
        expect(plan.replacedRules).toBe(1);
        expect(plan.diff).toContain("-    path: /telegram-webhook");
        expect(plan.diff).toContain("+    path: ^/telegram-webhook$");
        expect(plan.diff).toContain(`+    service: http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}`);
        expect(plan.diff).not.toContain("3042");
    });

    it("plans nothing for a config that already holds the rule", () => {
        const first = planTunnelChange({ configPath: "/x/config.yml", before: LEGACY_CONFIG, rule: RULE });
        const second = planTunnelChange({ configPath: "/x/config.yml", before: first.after, rule: RULE });

        expect(second.changed).toBe(false);
        expect(second.diff).toBe("");
    });

    function workDir() {
        const dir = mkdtempSync(join(tmpdir(), "tg-tunnel-"));
        const configPath = join(dir, "config.yml");
        writeFileSync(configPath, LEGACY_CONFIG);
        chmodSync(configPath, 0o640);

        return { dir, configPath, backupDir: join(dir, "backups") };
    }

    function recorder(failOn?: string) {
        const calls: Array<{ command: string; args: string[] }> = [];
        const run: CommandRunner = (command, args) => {
            calls.push({ command, args });

            return { stdout: "", stderr: command === failOn ? "boom" : "", status: command === failOn ? 1 : 0 };
        };

        return { calls, run };
    }

    it("backs up, writes, validates the written file, then restarts the tunnel", () => {
        const { configPath, backupDir } = workDir();
        const { calls, run } = recorder();
        const plan = planTunnelChange({ configPath, before: LEGACY_CONFIG, rule: RULE });

        const result = applyTunnelChange({
            plan,
            backupDir,
            run,
            uid: 501,
            now: () => new Date(2026, 9, 5, 14, 30, 7),
        });

        expect(readFileSync(result.backupPath, "utf8")).toBe(LEGACY_CONFIG);
        expect(result.backupPath).toBe(join(backupDir, "config.yml.20261005-143007.bak"));
        expect(readFileSync(configPath, "utf8")).toBe(plan.after);
        expect(statSync(configPath).mode & 0o777).toBe(0o640);
        expect(calls).toEqual([
            { command: "cloudflared", args: ["tunnel", "--config", configPath, "ingress", "validate"] },
            { command: "launchctl", args: ["kickstart", "-k", "gui/501/com.cloudflare.cloudflared"] },
        ]);
        expect(result.restarted).toBe(true);
    });

    it("keeps the first backup when a second change lands in the same second", () => {
        const { configPath, backupDir } = workDir();
        const { run } = recorder();
        const now = () => new Date(2026, 9, 5, 14, 30, 7);
        const firstPlan = planTunnelChange({ configPath, before: LEGACY_CONFIG, rule: RULE });
        const first = applyTunnelChange({ plan: firstPlan, backupDir, run, uid: undefined, now });

        const secondPlan = planTunnelChange({
            configPath,
            before: firstPlan.after,
            rule: { ...RULE, port: RULE.port + 1 },
        });
        expect(secondPlan.changed).toBe(true);
        const second = applyTunnelChange({ plan: secondPlan, backupDir, run, uid: undefined, now });

        expect(first.backupPath).toBe(join(backupDir, "config.yml.20261005-143007.bak"));
        expect(second.backupPath).toBe(join(backupDir, "config.yml.20261005-143007-2.bak"));
        expect(readFileSync(first.backupPath, "utf8")).toBe(LEGACY_CONFIG);
        expect(readFileSync(second.backupPath, "utf8")).toBe(firstPlan.after);
        expect(statSync(second.backupPath).mode & 0o777).toBe(0o600);
        expect(readdirSync(backupDir).sort()).toEqual([
            "config.yml.20261005-143007-2.bak",
            "config.yml.20261005-143007.bak",
        ]);
    });

    it("puts the original back and restarts nothing when cloudflared rejects the new rules", () => {
        const { configPath, backupDir } = workDir();
        const { calls, run } = recorder("cloudflared");
        const plan = planTunnelChange({ configPath, before: LEGACY_CONFIG, rule: RULE });

        expect(() => applyTunnelChange({ plan, backupDir, run, uid: 501 })).toThrow(/original config is back/);

        expect(readFileSync(configPath, "utf8")).toBe(LEGACY_CONFIG);
        expect(calls.map((call) => call.command)).toEqual(["cloudflared"]);
    });

    it("refuses to write over a file that changed after it was read", () => {
        const { configPath, backupDir } = workDir();
        const { calls, run } = recorder();
        const plan = planTunnelChange({ configPath, before: LEGACY_CONFIG, rule: RULE });
        writeFileSync(configPath, `${LEGACY_CONFIG}# edited meanwhile\n`);

        expect(() => applyTunnelChange({ plan, backupDir, run, uid: 501 })).toThrow(/changed since it was read/);

        expect(readFileSync(configPath, "utf8")).toBe(`${LEGACY_CONFIG}# edited meanwhile\n`);
        expect(calls).toEqual([]);
    });

    it("keeps the valid new rules and says so when only the restart fails", () => {
        const { configPath, backupDir } = workDir();
        const { run } = recorder("launchctl");
        const plan = planTunnelChange({ configPath, before: LEGACY_CONFIG, rule: RULE });

        expect(() => applyTunnelChange({ plan, backupDir, run, uid: 501 })).toThrow(/Restart the tunnel yourself/);
        expect(readFileSync(configPath, "utf8")).toBe(plan.after);
    });

    it("skips the restart when there is no user id to address launchd with", () => {
        const { configPath, backupDir } = workDir();
        const { calls, run } = recorder();
        const plan = planTunnelChange({ configPath, before: LEGACY_CONFIG, rule: RULE });

        expect(applyTunnelChange({ plan, backupDir, run, uid: undefined }).restarted).toBe(false);
        expect(calls.map((call) => call.command)).toEqual(["cloudflared"]);
    });
});
