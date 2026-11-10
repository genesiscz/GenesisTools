import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOAuth } from "@genesiscz/utils/claude/auth";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { APICallError, generateText } from "ai";
import { AiConfigStore } from "../../config/AiConfigStore";
import { type AccountEntry, CONFIG_VERSION } from "../../config/schema";
import { grokOAuth } from "../../grok/oauth";
import { codexOAuth } from "../../openai/codex-auth";
import type { WhamModelRecord } from "../../openai/sub-models";
import { anthropicSubPlugin } from "./anthropic-sub";
import { grokSubPlugin } from "./grok-sub";
import { openAiSubPlugin } from "./openai-sub";
import { listOpenAiSubModels, OPENAI_SUB_MODEL_LIST_TTL_MS, resetOpenAiSubModelLists } from "./openai-sub/models";

/**
 * The subscription plugins' `bind`. A Claude, Codex or Grok refresh token is single-use, so every
 * test here runs on a sandboxed home with invented accounts, a fake transport and a spy on the
 * refresh primitive that throws when a path reaches it unexpectedly.
 */

let home: string;

function jwt(payload: Record<string, unknown>): string {
    return `e30.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.test`;
}

function codexToken(workspace: string, marker: string, expires = Date.now() + 3_600_000): string {
    return jwt({
        exp: Math.floor(expires / 1000),
        marker,
        "https://api.openai.com/auth": { chatgpt_account_id: workspace },
    });
}

function saveConfig(accounts: AccountEntry[]): void {
    writeFileSync(
        join(home, ".genesis-tools/ai/config.json"),
        SafeJSON.stringify({ version: CONFIG_VERSION, accounts, defaults: {} })
    );
    AiConfigStore.invalidate();
}

function codexAccount(): AccountEntry {
    return {
        id: "acc_codex_work",
        name: "work",
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {
            accessToken: codexToken("workspace-a", "first"),
            refreshToken: "codex-refresh-1",
            expiresAt: Date.now() + 3_600_000,
        },
        accountUuid: "workspace-a",
        useEnvApiKey: false,
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-subscription-bind-"));
    mkdirSync(join(home, ".genesis-tools/ai"), { recursive: true });
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const key = Buffer.alloc(32, 23);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => key, getSync: () => key, set: async () => {} },
    ]);
    _resetSecretsForTest();
    resetOpenAiSubModelLists();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    AiConfigStore.invalidate();
});

describe("openai-sub bind", () => {
    test("binding performs zero fetch calls, for real use and for a probe", async () => {
        const account = codexAccount();
        saveConfig([account]);
        const calls: string[] = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
            calls.push(String(input));
            throw new Error(`bind reached the network: ${String(input)}`);
        }) as unknown as typeof fetch);
        const transport = (async (input: RequestInfo | URL): Promise<Response> => {
            calls.push(String(input));
            throw new Error(`bind reached the transport: ${String(input)}`);
        }) as typeof fetch;

        try {
            const real = await openAiSubPlugin.bind({ account, fetch: transport });
            const probe = await openAiSubPlugin.bind({ account, probe: true, fetch: transport });
            real.language("gpt-6.1-sol");
            probe.language("gpt-6.1-sol");
        } finally {
            fetchSpy.mockRestore();
        }

        expect(calls).toEqual([]);
    });

    test("the picker's live list is fetched once per account within ten minutes", async () => {
        const account = codexAccount();
        let now = 1_000_000;
        let fetched = 0;
        const record: WhamModelRecord = {
            slug: "gpt-fixture-live",
            displayName: "GPT Fixture Live",
            contextWindow: 100_000,
            visibility: "list",
        };
        const deps = {
            now: () => now,
            fetchRecords: async () => {
                fetched += 1;
                return [record, { ...record, slug: "gpt-fixture-hidden", visibility: "hide" as const }];
            },
        };

        const first = await listOpenAiSubModels(account, deps);
        now += OPENAI_SUB_MODEL_LIST_TTL_MS - 1;
        await listOpenAiSubModels(account, deps);

        expect(first.map((entry) => entry.id)).toEqual(["gpt-fixture-live"]);
        expect(fetched).toBe(1);

        now += 2;
        await listOpenAiSubModels(account, deps);
        expect(fetched).toBe(2);
    });

    test("an unreadable live list answers with the static catalog and is not kept", async () => {
        const account = codexAccount();
        let fetched = 0;
        const deps = {
            fetchRecords: async () => {
                fetched += 1;
                return null;
            },
        };

        const fallback = await listOpenAiSubModels(account, deps);
        await listOpenAiSubModels(account, deps);

        expect(fallback.length).toBeGreaterThan(0);
        expect(fallback.every((entry) => entry.source === "static")).toBe(true);
        expect(fetched).toBe(2);
    });
});

interface Sent {
    authorization: string | null;
    workspace: string | null;
}

/** A transport that answers 401 to the first `rejections` requests and `ok()` afterwards. */
function transport(rejections: number, ok: () => Response): { fetch: typeof fetch; sent: Sent[] } {
    const sent: Sent[] = [];
    const fake = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        sent.push({ authorization: headers.get("authorization"), workspace: headers.get("chatgpt-account-id") });

        if (sent.length <= rejections) {
            return new Response(
                SafeJSON.stringify({ error: { type: "authentication_error", message: "fixture 401" } }),
                {
                    status: 401,
                    headers: { "content-type": "application/json" },
                }
            );
        }

        return ok();
    };

    return { fetch: fake as typeof fetch, sent };
}

async function statusOf(promise: Promise<unknown>): Promise<number | "ok"> {
    try {
        await promise;
        return "ok";
    } catch (err) {
        if (APICallError.isInstance(err)) {
            return err.statusCode ?? -1;
        }

        throw err;
    }
}

function anthropicAccount(expiresAt = Date.now() + 3_600_000): AccountEntry {
    return {
        id: "acc_claude_work",
        name: "work",
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { accessToken: "claude-access-1", refreshToken: "claude-refresh-1", expiresAt },
        useEnvApiKey: false,
    };
}

function anthropicOk(): Response {
    return Response.json({
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "pong" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
    });
}

describe("anthropic-sub bind", () => {
    test("a 401 recovers once: exactly one refresh, and the request repeats with the new token", async () => {
        const account = anthropicAccount();
        saveConfig([account]);
        const refresh = spyOn(claudeOAuth, "refresh").mockImplementation(async (refreshToken: string) => {
            expect(refreshToken).toBe("claude-refresh-1");
            return {
                accessToken: "claude-access-2",
                refreshToken: "claude-refresh-2",
                expiresAt: Date.now() + 3_600_000,
                scopes: [],
            };
        });
        const wire = transport(1, anthropicOk);

        try {
            const binding = await anthropicSubPlugin.bind({ account, fetch: wire.fetch });
            const result = await generateText({
                model: binding.language("claude-haiku-5-5"),
                prompt: "ping",
                maxRetries: 0,
            });

            expect(result.text).toBe("pong");
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(wire.sent.map((request) => request.authorization)).toEqual([
                "Bearer claude-access-1",
                "Bearer claude-access-2",
            ]);
        } finally {
            refresh.mockRestore();
        }
    });

    test("a second 401 surfaces as an error after the one refresh", async () => {
        const account = anthropicAccount();
        saveConfig([account]);
        const refresh = spyOn(claudeOAuth, "refresh").mockImplementation(async () => ({
            accessToken: "claude-access-2",
            refreshToken: "claude-refresh-2",
            expiresAt: Date.now() + 3_600_000,
            scopes: [],
        }));
        const wire = transport(2, anthropicOk);

        try {
            const binding = await anthropicSubPlugin.bind({ account, fetch: wire.fetch });
            const status = await statusOf(
                generateText({ model: binding.language("claude-haiku-5-5"), prompt: "ping", maxRetries: 0 })
            );

            expect(status).toBe(401);
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(wire.sent).toHaveLength(2);
        } finally {
            refresh.mockRestore();
        }
    });

    test("a probe bind of an expired account never reaches the refresh", async () => {
        const account = anthropicAccount(Date.now() - 60_000);
        saveConfig([account]);
        const refresh = spyOn(claudeOAuth, "refresh").mockImplementation(async () => {
            throw new Error("a probe spent the single-use refresh token");
        });

        try {
            await expect(anthropicSubPlugin.bind({ account, probe: true })).rejects.toThrow("refresh is disabled");
            expect(refresh).not.toHaveBeenCalled();
        } finally {
            refresh.mockRestore();
        }
    });
});

function codexOk(): Response {
    const events = [
        {
            type: "response.output_item.done",
            output_index: 0,
            item: {
                type: "message",
                id: "msg_fixture",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "pong", annotations: [] }],
            },
        },
        {
            type: "response.completed",
            response: {
                id: "resp_fixture",
                object: "response",
                model: "gpt-6.1-sol",
                created_at: 1_700_000_000,
                status: "completed",
                output: [],
                usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            },
        },
    ];

    return new Response(events.map((event) => `data: ${SafeJSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
    });
}

describe("openai-sub bind auth", () => {
    test("a 401 recovers once: exactly one refresh, and the request repeats with the new token", async () => {
        const account = codexAccount();
        saveConfig([account]);
        const second = codexToken("workspace-a", "second");
        const refresh = spyOn(codexOAuth, "refresh").mockImplementation(async (refreshToken: string) => {
            expect(refreshToken).toBe("codex-refresh-1");
            return { accessToken: second, refreshToken: "codex-refresh-2", expiresAt: Date.now() + 3_600_000 };
        });
        const wire = transport(1, codexOk);

        try {
            const binding = await openAiSubPlugin.bind({ account, fetch: wire.fetch });
            const result = await generateText({
                model: binding.language("gpt-6.1-sol"),
                prompt: "ping",
                maxRetries: 0,
            });

            expect(result.text).toBe("pong");
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(wire.sent).toEqual([
                {
                    authorization: `Bearer ${codexToken("workspace-a", "first", account.credentials.expiresAt)}`,
                    workspace: "workspace-a",
                },
                { authorization: `Bearer ${second}`, workspace: "workspace-a" },
            ]);
        } finally {
            refresh.mockRestore();
        }
    });

    test("a second 401 surfaces as an error after the one refresh", async () => {
        const account = codexAccount();
        saveConfig([account]);
        const refresh = spyOn(codexOAuth, "refresh").mockImplementation(async () => ({
            accessToken: codexToken("workspace-a", "second"),
            refreshToken: "codex-refresh-2",
            expiresAt: Date.now() + 3_600_000,
        }));
        const wire = transport(2, codexOk);

        try {
            const binding = await openAiSubPlugin.bind({ account, fetch: wire.fetch });
            const status = await statusOf(
                generateText({ model: binding.language("gpt-6.1-sol"), prompt: "ping", maxRetries: 0 })
            );

            expect(status).toBe(401);
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(wire.sent).toHaveLength(2);
        } finally {
            refresh.mockRestore();
        }
    });
});

function grokToken(marker: string): string {
    return jwt({ exp: Math.floor((Date.now() + 3_600_000) / 1000), sub: "xai-user-invented", marker });
}

function grokAccount(): AccountEntry {
    return {
        id: "acc_grok_work",
        name: "work",
        provider: "grok-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {
            accessToken: grokToken("first"),
            refreshToken: "grok-refresh-1",
            expiresAt: Date.now() + 3_600_000,
        },
        useEnvApiKey: false,
    };
}

function grokOk(): Response {
    return Response.json({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        created: 0,
        model: "grok-4.5",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
}

describe("grok-sub bind", () => {
    test("a 401 recovers once: exactly one refresh, and the request repeats with the new token", async () => {
        const account = grokAccount();
        const first = account.credentials.accessToken;
        saveConfig([account]);
        const second = grokToken("second");
        const refresh = spyOn(grokOAuth, "refresh").mockImplementation(async (refreshToken: string) => {
            expect(refreshToken).toBe("grok-refresh-1");
            return { accessToken: second, refreshToken: "grok-refresh-2", expiresAt: Date.now() + 3_600_000 };
        });
        const wire = transport(1, grokOk);

        try {
            const binding = await grokSubPlugin.bind({ account, fetch: wire.fetch });
            const result = await generateText({ model: binding.language("grok-4.5"), prompt: "ping", maxRetries: 0 });

            expect(result.text).toBe("pong");
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(wire.sent.map((request) => request.authorization)).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
        } finally {
            refresh.mockRestore();
        }
    });

    test("a second 401 surfaces as an error after the one refresh", async () => {
        const account = grokAccount();
        saveConfig([account]);
        const refresh = spyOn(grokOAuth, "refresh").mockImplementation(async () => ({
            accessToken: grokToken("second"),
            refreshToken: "grok-refresh-2",
            expiresAt: Date.now() + 3_600_000,
        }));
        const wire = transport(2, grokOk);

        try {
            const binding = await grokSubPlugin.bind({ account, fetch: wire.fetch });
            const status = await statusOf(
                generateText({ model: binding.language("grok-4.5"), prompt: "ping", maxRetries: 0 })
            );

            expect(status).toBe(401);
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(wire.sent).toHaveLength(2);
        } finally {
            refresh.mockRestore();
        }
    });
});
