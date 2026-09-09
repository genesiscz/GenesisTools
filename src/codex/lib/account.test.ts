import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AccountEntry, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AppServerProcess } from "@genesiscz/utils/ai/openai/app-server-client";
import { resolveCodexAccountToken } from "@genesiscz/utils/ai/openai/codex-auth";
import { resolveNativeCodexModel } from "@genesiscz/utils/ai/openai/resolve-native-model";
import { pollCodexAccount } from "@genesiscz/utils/ai/providers/plugins/openai-sub/usage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    resolveSecret,
} from "@genesiscz/utils/security";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";
import { CodexAccountBinding } from "./account";

let home: string;
let account: AccountEntry;
function token(accountId: string, expires = Date.now() + 3600000): string {
    return `e30.${Buffer.from(SafeJSON.stringify({ exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.test`;
}
function saveConfig(): void {
    writeFileSync(
        join(home, ".genesis-tools/ai/config.json"),
        SafeJSON.stringify({ version: CONFIG_VERSION, accounts: [account], defaults: {} })
    );
    AiConfigStore.invalidate();
}
function saveAuth(accountId = "workspace-a", expires?: number): string {
    const path = join(home, "account-auth.json");
    writeFileSync(
        path,
        SafeJSON.stringify({
            tokens: {
                access_token: token(accountId, expires),
                refresh_token: "never-spend-this",
                account_id: accountId,
            },
        })
    );
    return path;
}
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-codex-binding-"));
    mkdirSync(join(home, ".genesis-tools/ai"), { recursive: true });
    env.testing.set("GENESIS_TOOLS_HOME", home);
    const key = Buffer.alloc(32, 19);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => key, getSync: () => key, set: async () => {} },
    ]);
    _resetSecretsForTest();
    account = {
        id: "acc_a",
        name: "work",
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { authFile: saveAuth() },
        accountUuid: "workspace-a",
        useEnvApiKey: false,
    };
    saveConfig();
});
afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    AiConfigStore.invalidate();
});
test("binds the requested account without rewriting its credential file", async () => {
    const before = readFileSync(join(home, "account-auth.json"), "utf8");
    const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
    expect(binding.accountId).toBe("acc_a");
    expect((await binding.tokens()).chatgptAccountId).toBe("workspace-a");
    expect(readFileSync(join(home, "account-auth.json"), "utf8")).toBe(before);
});

test.each(["disabled", "provider", "identity", "expired", "deleted"])(
    "refuses %s credentials instead of falling back to another account",
    async (scenario) => {
        const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
        if (scenario === "disabled") {
            account.enabled = false;
        }
        if (scenario === "provider") {
            account.provider = "anthropic-sub";
        }
        if (scenario === "identity") {
            saveAuth("workspace-b");
        }
        if (scenario === "expired") {
            saveAuth("workspace-a", Date.now() - 10000);
        }
        if (scenario === "deleted") {
            account.id = "replacement";
        }
        saveConfig();
        await expect(binding.tokens()).rejects.toThrow();
        expect(readFileSync(join(home, "account-auth.json"), "utf8")).toContain("never-spend-this");
    }
);

test("concurrent broker refreshes spend the grant once and persist the rotated pair", async () => {
    account.credentials = {
        accessToken: token("workspace-a", Date.now() - 60000),
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 60000,
    };
    saveConfig();
    const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async (input: URL | RequestInfo, init?: RequestInit) => {
                expect(String(input)).toBe("https://auth.openai.com/oauth/token");
                expect(SafeJSON.parse(String(init?.body))).toMatchObject({ refresh_token: "old-refresh" });
                return Response.json({
                    access_token: token("workspace-a"),
                    refresh_token: "new-refresh",
                    expires_in: 3600,
                });
            },
            { preconnect: fetch.preconnect }
        )
    );
    try {
        const one = await CodexAccountBinding.create("work", { allowRefresh: true });
        const two = await CodexAccountBinding.create("work", { allowRefresh: true });
        const values = await Promise.all([one.tokens(), two.tokens()]);
        expect(values.map((value) => value.chatgptAccountId)).toEqual(["workspace-a", "workspace-a"]);
        expect(network).toHaveBeenCalledTimes(1);
        const stored = (await AiConfigStore.load()).account("acc_a");
        expect(await resolveSecret(stored?.credentials.refreshToken)).toBe("new-refresh");
    } finally {
        network.mockRestore();
    }
});

test("external authentication precedes thread creation and refresh refuses another workspace", async () => {
    const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
        async request<T>(method: string, params?: unknown): Promise<T> {
            calls.push({ method, params });
            return { type: "chatgptAuthTokens" } as T;
        },
    };
    await binding.authenticate(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
        method: "account/login/start",
        params: { type: "chatgptAuthTokens", chatgptAccountId: "workspace-a" },
    });
    await expect(binding.refresh("workspace-b")).rejects.toThrow("different account");
    await expect(binding.refresh("workspace-a")).rejects.toThrow("CLI-owned");
});

test("a diagnostic probe never refreshes expired vault credentials", async () => {
    account.credentials = {
        accessToken: token("workspace-a", Date.now() - 60000),
        refreshToken: "probe-must-not-spend",
        expiresAt: Date.now() - 60000,
    };
    saveConfig();
    // Complete the fixture's normal config/vault migration before measuring the probe.
    const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
    const before = readFileSync(join(home, ".genesis-tools/ai/config.json"), "utf8");
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("probe must not access OAuth"));
    try {
        await expect(binding.tokens({ refresh: false })).rejects.toThrow("expired");
        expect(network).not.toHaveBeenCalled();
        expect(readFileSync(join(home, ".genesis-tools/ai/config.json"), "utf8")).toBe(before);
    } finally {
        network.mockRestore();
    }
});

// Exercise the real usage handshake and cleanup; only the OS child is synthetic.
test.each(["success", "initialize", "account/login/start", "refresh-probe", "refresh-owned", "refresh-owned-wrong"])(
    "usage authenticates before reading quotas and cleans its owned home (phase=%s)",
    async (phase) => {
        const isRefresh = phase.startsWith("refresh-");
        if (isRefresh) {
            account.credentials = {
                accessToken: token("workspace-a"),
                refreshToken: "owned-refresh",
                expiresAt: Date.now() + 3600000,
            };
            saveConfig();
        }
        let refreshes = 0;
        let callbackError: string | undefined;
        let pendingRateId: number | undefined;
        const network = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                async (_input: URL | RequestInfo, init?: RequestInit) => {
                    refreshes++;
                    expect(SafeJSON.parse(String(init?.body))).toMatchObject({ refresh_token: "owned-refresh" });
                    return Response.json({
                        access_token: token("workspace-a", Date.now() + 7200000),
                        refresh_token: "rotated",
                        expires_in: 7200,
                    });
                },
                { preconnect: fetch.preconnect }
            )
        );
        try {
            let temporaryHome = "";
            let exited = false;
            let closes = 0;
            const methods: string[] = [];
            const snapshot = await pollCodexAccount(
                account,
                { probe: !phase.startsWith("refresh-owned") },
                {
                    spawnProcess(options) {
                        temporaryHome = options.home!;
                        expect(temporaryHome).not.toBe(home);
                        expect(options.config).toContain('cli_auth_credentials_store="ephemeral"');
                        expect(options.unsetEnv).toContain("CODEX_ACCESS_TOKEN");
                        mkdirSync(join(temporaryHome, "nested"));
                        writeFileSync(join(temporaryHome, "nested", "state.db"), "synthetic vendor state");
                        let output!: ReadableStreamDefaultController<Uint8Array>;
                        let finish!: (code: number) => void;
                        const process: AppServerProcess = {
                            pid: 123,
                            stdout: new ReadableStream({
                                start(controller) {
                                    output = controller;
                                },
                            }),
                            stderr: new ReadableStream({
                                start(controller) {
                                    controller.close();
                                },
                            }),
                            exited: new Promise<number>((resolve) => {
                                finish = resolve;
                            }),
                            stdin: {
                                write(value) {
                                    const request = SafeJSON.parse(String(value), { strict: true }) as {
                                        id?: number;
                                        method: string;
                                        error?: { message: string };
                                        result?: { accessToken: string };
                                        params?: {
                                            capabilities?: { experimentalApi?: boolean };
                                            type?: string;
                                            chatgptAccountId?: string;
                                        };
                                    };
                                    if (request.id === 999 && !request.method) {
                                        callbackError = request.error?.message;
                                        if (phase === "refresh-owned") {
                                            expect(request.result?.accessToken).toBeTruthy();
                                        }
                                        const response = callbackError
                                            ? { id: pendingRateId, error: { message: callbackError } }
                                            : {
                                                  id: pendingRateId,
                                                  result: { rateLimits: { primary: { usedPercent: 17 } } },
                                              };
                                        output.enqueue(new TextEncoder().encode(`${SafeJSON.stringify(response)}\n`));
                                        return String(value).length;
                                    }
                                    methods.push(request.method);
                                    if (request.id === undefined) {
                                        return String(value).length;
                                    }
                                    if (request.method === "initialize") {
                                        expect(request.params?.capabilities?.experimentalApi).toBe(true);
                                    }
                                    if (request.method === "account/login/start") {
                                        expect(request.params?.type).toBe("chatgptAuthTokens");
                                        expect(request.params?.chatgptAccountId).toBe("workspace-a");
                                    }
                                    if (request.method === "account/rateLimits/read" && isRefresh) {
                                        pendingRateId = request.id;
                                        output.enqueue(
                                            new TextEncoder().encode(
                                                `${SafeJSON.stringify({
                                                    id: 999,
                                                    method: "account/chatgptAuthTokens/refresh",
                                                    params: {
                                                        previousAccountId: phase.endsWith("wrong")
                                                            ? "workspace-b"
                                                            : "workspace-a",
                                                    },
                                                })}\n`
                                            )
                                        );
                                        return String(value).length;
                                    }
                                    const result =
                                        request.method === "account/login/start"
                                            ? { type: "chatgptAuthTokens" }
                                            : request.method === "account/rateLimits/read"
                                              ? { rateLimits: { primary: { usedPercent: 17 } } }
                                              : {};
                                    const response =
                                        request.method === phase
                                            ? { id: request.id, error: { message: "synthetic login failure" } }
                                            : { id: request.id, result };
                                    output.enqueue(new TextEncoder().encode(`${SafeJSON.stringify(response)}\n`));
                                    return String(value).length;
                                },
                                end() {
                                    return 0;
                                },
                            },
                            kill() {
                                closes += 1;
                                queueMicrotask(() => {
                                    exited = true;
                                    output.close();
                                    finish(0);
                                });
                            },
                        };
                        return process;
                    },
                }
            ).catch((error: Error) => error);
            if (isRefresh) {
                expect(methods).toEqual([
                    "initialize",
                    "initialized",
                    "account/login/start",
                    "account/rateLimits/read",
                ]);
                expect(refreshes).toBe(phase === "refresh-owned" ? 1 : 0);
                if (phase === "refresh-owned") {
                    expect(snapshot).toMatchObject({ limits: [{ percentUsed: 17 }] });
                    expect(callbackError).toBeUndefined();
                } else {
                    expect(snapshot).toBeInstanceOf(Error);
                    expect(callbackError).toContain(phase.endsWith("wrong") ? "different account" : "unavailable");
                }
            } else if (phase !== "success") {
                expect(snapshot).toBeInstanceOf(Error);
                expect(methods).toEqual(
                    phase === "initialize" ? ["initialize"] : ["initialize", "initialized", "account/login/start"]
                );
            } else {
                expect(snapshot).toMatchObject({ accountId: account.id, limits: [{ percentUsed: 17 }] });
                expect(methods).toEqual([
                    "initialize",
                    "initialized",
                    "account/login/start",
                    "account/rateLimits/read",
                ]);
            }
            expect(exited).toBe(true);
            expect(closes).toBe(1);
            expect(temporaryHome).not.toBe("");
            expect(existsSync(temporaryHome)).toBe(false);
            expect(existsSync(home)).toBe(true);
        } finally {
            network.mockRestore();
        }
    }
);

test("legacy token resolver and launcher share one refresh owner and the networked lock budget", async () => {
    account.credentials = {
        accessToken: token("workspace-a", Date.now() - 60000),
        refreshToken: "one-shared-grant",
        expiresAt: Date.now() - 60000,
    };
    saveConfig();
    const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
    const lock = spyOn(AiConfigStore.prototype, "withLock");
    const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async () =>
                Response.json({
                    access_token: token("workspace-a"),
                    refresh_token: "rotated-shared-grant",
                    expires_in: 3600,
                }),
            { preconnect: fetch.preconnect }
        )
    );
    try {
        const [launched, legacy] = await Promise.all([binding.tokens(), resolveCodexAccountToken("work")]);
        expect(launched.accessToken).toBe(legacy.token);
        expect(legacy.accountId).toBe("workspace-a");
        expect(network).toHaveBeenCalledTimes(1);
        expect(lock.mock.calls.length).toBeGreaterThan(0);
        for (const call of lock.mock.calls) {
            expect(call[1]).toBe(NETWORKED_LOCK_WAIT_MS);
        }
        expect(await resolveSecret((await AiConfigStore.load()).account("acc_a")?.credentials.refreshToken)).toBe(
            "rotated-shared-grant"
        );
    } finally {
        network.mockRestore();
        lock.mockRestore();
    }
});

test("legacy token resolution refuses changed identity using the same account contract", async () => {
    saveAuth("workspace-b");
    await expect(resolveCodexAccountToken("work", { noRefresh: true })).rejects.toThrow("identity changed");
});

test("fresh legacy token reads never take a refresh lock or call the network", async () => {
    account.credentials = {
        accessToken: token("workspace-a"),
        refreshToken: "fresh-unspent",
        expiresAt: Date.now() + 3600000,
    };
    saveConfig();
    await AiConfigStore.load();
    const lock = spyOn(AiConfigStore.prototype, "withLock");
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("fresh read must not fetch"));
    try {
        expect((await resolveCodexAccountToken("work")).accountId).toBe("workspace-a");
        expect(lock).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
    } finally {
        network.mockRestore();
        lock.mockRestore();
    }
});

test("a diagnostic binding does not migrate or rewrite account storage on first read", async () => {
    account.credentials = {
        accessToken: token("workspace-a"),
        refreshToken: "unmigrated",
        expiresAt: Date.now() + 3600000,
    };
    saveConfig();
    const path = join(home, ".genesis-tools/ai/config.json");
    const before = readFileSync(path, "utf8");
    const binding = await CodexAccountBinding.create("work", { allowRefresh: false });
    expect((await binding.tokens()).chatgptAccountId).toBe("workspace-a");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(home, ".genesis-tools/security/vault.json"))).toBe(false);
    await expect(binding.refresh("workspace-a")).rejects.toThrow("diagnosis");
});

test("native model aliases preserve the selected account and never refresh credentials", async () => {
    account.credentials = {
        accessToken: token("workspace-a", 1),
        refreshToken: "unspent-model-resolution",
        expiresAt: 1,
    };
    saveConfig();
    const before = readFileSync(join(home, ".genesis-tools/ai/config.json"), "utf8");
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("model resolution must not fetch"));
    try {
        expect(await resolveNativeCodexModel("acc_a", "astra")).toBe("gpt-6-astra");
        expect(await resolveNativeCodexModel("acc_a", "codex/terra")).toBe("gpt-5.6-terra");
        await expect(resolveNativeCodexModel("acc_a", "@account/another:sol")).rejects.toThrow("account");
        await expect(resolveNativeCodexModel("acc_a", "grok/grok-4")).rejects.toThrow("provider");
        expect(network).not.toHaveBeenCalled();
        expect(readFileSync(join(home, ".genesis-tools/ai/config.json"), "utf8")).toBe(before);
    } finally {
        network.mockRestore();
    }
});

test("provider health leaves unmigrated account and vault storage unchanged", async () => {
    const { openAiSubPlugin } = await import("@genesiscz/utils/ai/providers/plugins/openai-sub");
    account.credentials = {
        accessToken: token("workspace-a"),
        refreshToken: "health-unspent",
        expiresAt: Date.now() + 3600000,
    };
    saveConfig();
    const path = join(home, ".genesis-tools/ai/config.json");
    const before = readFileSync(path, "utf8");
    const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async (input: URL | RequestInfo) => {
                expect(String(input)).toContain("/models");
                return Response.json({ models: [] });
            },
            { preconnect: fetch.preconnect }
        )
    );
    try {
        expect(await openAiSubPlugin.health!({ account })).toMatchObject({ ok: true });
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(existsSync(join(home, ".genesis-tools/security/vault.json"))).toBe(false);
    } finally {
        network.mockRestore();
    }
});

test("a bound provider keeps the original account after its name is reused", async () => {
    const { openAiSubPlugin } = await import("@genesiscz/utils/ai/providers/plugins/openai-sub");
    const workspaces: Array<string | null> = [];
    const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async (input: URL | RequestInfo, init?: RequestInit) => {
                if (String(input).includes("/models")) {
                    return Response.json({ models: [] });
                }
                workspaces.push(new Headers(init?.headers).get("ChatGPT-Account-Id"));
                return Response.json({ error: { message: "synthetic stop", type: "fixture" } }, { status: 400 });
            },
            { preconnect: fetch.preconnect }
        )
    );
    try {
        const bound = await openAiSubPlugin.bind({ account });
        account.name = "renamed";
        writeFileSync(
            join(home, ".genesis-tools/ai/config.json"),
            SafeJSON.stringify({
                version: CONFIG_VERSION,
                defaults: {},
                accounts: [
                    account,
                    {
                        ...account,
                        id: "acc_replacement",
                        name: "work",
                        accountUuid: "workspace-b",
                        credentials: {
                            accessToken: token("workspace-b"),
                            refreshToken: "replacement-grant",
                            expiresAt: Date.now() + 3600000,
                        },
                    },
                ],
            })
        );
        AiConfigStore.invalidate();
        const model = bound.language("gpt-6-astra");
        if (typeof model === "string") {
            throw new Error("Expected a bound language model");
        }
        await Promise.resolve(
            model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Fixture" }] }] })
        ).catch(() => undefined);
        expect(workspaces).toEqual(["workspace-a"]);
    } finally {
        network.mockRestore();
    }
});

test("an explicit legacy native data directory remains a read-only credential reference", async () => {
    const authFile = join(home, "auth.json");
    const original = readFileSync(join(home, "account-auth.json"), "utf8");
    writeFileSync(authFile, original);
    account.credentials = { dataDir: home };
    saveConfig();
    const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
    expect((await binding.tokens()).chatgptAccountId).toBe("workspace-a");
    await expect(binding.refresh("workspace-a")).rejects.toThrow("CLI-owned");
    expect(readFileSync(authFile, "utf8")).toBe(original);
});

test("an unavailable vault key is detected before spending a legacy plaintext refresh grant", async () => {
    _setMasterKeyProvidersForTest([]);
    _resetSecretsForTest();
    account.credentials = { accessToken: token("workspace-a", 1), refreshToken: "do-not-spend", expiresAt: 1 };
    saveConfig();
    const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async () =>
                Response.json({
                    access_token: token("workspace-a"),
                    refresh_token: "would-be-lost",
                    expires_in: 3600,
                }),
            { preconnect: fetch.preconnect }
        )
    );
    try {
        const binding = await CodexAccountBinding.create("work", { allowRefresh: true });
        await expect(binding.tokens()).rejects.toThrow("master key");
        expect(network).not.toHaveBeenCalled();
    } finally {
        network.mockRestore();
    }
});
