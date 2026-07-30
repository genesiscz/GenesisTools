import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCopilotSession } from "@genesiscz/utils/ai/github-copilot";
import { claudeOAuth } from "@genesiscz/utils/claude/auth";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    resolveSecret,
} from "@genesiscz/utils/security";
import { AIConfig } from "../AIConfig";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "../providers/plugins";
import { _resetPluginsForTest, providerPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import { testAccount } from "./account-ops";
import { runDoctor } from "./doctor";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "./schema";

/**
 * A refresh token is SINGLE-USE and its replacement only survives if the config
 * write lands. `doctor --live` runs in exactly the situation where that write is
 * guarded (a worktree build), so a health probe that refreshed would spend the
 * grant and be unable to persist the rotated pair, silently bricking the
 * account. Observed live on 2026-07-29: doctor printed
 * "[token-refresh] reservine: initiating refresh (reason: token-expired)".
 *
 * These tests pin the rule at every end: the gate inside `resolveAccountToken`,
 * the plugin health path `doctor` walks, and the plugin BIND path
 * `tools ai config account test` walks. The spy throws, so any probe that ever
 * reaches the refresh call fails loudly instead of quietly spending a grant.
 */

const KEY = Buffer.alloc(32, 4);
const HOUR = 60 * 60 * 1000;

let home: string;
let refreshCalls: string[];
let realRefresh: typeof claudeOAuth.refresh;

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_expired",
        name: "expired-sub",
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {
            accessToken: "sk-ant-oat01-stale",
            refreshToken: "sk-ant-ort01-single-use",
            expiresAt: Date.now() - HOUR,
        },
        useEnvApiKey: false,
        ...overrides,
    };
}

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

/**
 * Seed the config and let the migration chain settle.
 *
 * The chain moves plaintext credentials into the vault on first load, which
 * legitimately rewrites the file. Settling it here means a later byte
 * comparison measures ONLY what the probe did, which is the thing under test.
 */
async function seed(accounts: AccountEntry[]): Promise<void> {
    const data: AiConfigData = { version: CONFIG_VERSION, accounts, defaults: {} };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    // Both caches: `resolveAccountToken` reads through the v3 facade, whose
    // singleton does not notice an AiConfigStore reset on its own.
    AIConfig.invalidate();
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

function readConfig(): AiConfigData {
    return SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
}

/** The stored refresh token's VALUE, whether it sits inline or in the vault. */
async function storedRefreshToken(): Promise<string | undefined> {
    return resolveSecret(readConfig().accounts[0].credentials.refreshToken);
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-norefresh-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    registerBuiltInPlugins();
    await seed([account()]);

    // Spy on the ONE entrypoint that spends the grant. It throws so that any
    // call is both counted and unmistakable in the failure output.
    refreshCalls = [];
    realRefresh = claudeOAuth.refresh.bind(claudeOAuth);
    claudeOAuth.refresh = async (refreshToken: string) => {
        refreshCalls.push(refreshToken);
        throw new Error("a diagnostic probe must never reach claudeOAuth.refresh");
    };
});

afterEach(() => {
    claudeOAuth.refresh = realRefresh;
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AIConfig.invalidate();
});

describe("resolveAccountToken noRefresh gate", () => {
    test("an expired token reports the re-login command and spends no grant", async () => {
        const before = readFileSync(configPath(), "utf8");

        await expect(resolveAccountToken("expired-sub", { noRefresh: true })).rejects.toThrow(
            "tools claude login expired-sub"
        );

        expect(refreshCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(await storedRefreshToken()).toBe("sk-ant-ort01-single-use");
    });

    test("a still-valid token resolves normally under noRefresh", async () => {
        await seed([
            account({
                credentials: {
                    accessToken: "sk-ant-oat01-fresh",
                    refreshToken: "sk-ant-ort01-single-use",
                    expiresAt: Date.now() + 24 * HOUR,
                },
            }),
        ]);

        const resolved = await resolveAccountToken("expired-sub", { noRefresh: true });

        expect(resolved.token).toBe("sk-ant-oat01-fresh");
        expect(resolved.refreshed).toBe(false);
        expect(refreshCalls).toEqual([]);
    });

    test("noRefresh beats forceRefresh: diagnosis never rotates", async () => {
        await seed([
            account({
                credentials: {
                    accessToken: "sk-ant-oat01-fresh",
                    refreshToken: "sk-ant-ort01-single-use",
                    expiresAt: Date.now() + 24 * HOUR,
                },
            }),
        ]);

        await expect(resolveAccountToken("expired-sub", { noRefresh: true, forceRefresh: true })).rejects.toThrow(
            "refresh is disabled for diagnosis"
        );
        expect(refreshCalls).toEqual([]);
    });
});

describe("runDoctor --live over an expired subscription account", () => {
    test("emits the fail row and performs zero refresh attempts", async () => {
        const before = readFileSync(configPath(), "utf8");

        const report = await runDoctor({ live: true });
        const health = report.checks.filter((check) => check.id === "account.health");

        expect(refreshCalls).toEqual([]);
        expect(health).toHaveLength(1);
        expect(health[0].scope).toBe("expired-sub");
        expect(health[0].level).toBe("err");
        expect(health[0].detail).toContain("tools claude login expired-sub");
        expect(report.ok).toBe(false);

        // The whole point: the stored grant is exactly as it was.
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("without --live no health probe runs at all", async () => {
        const report = await runDoctor({});

        expect(report.checks.filter((check) => check.id === "account.health")).toHaveLength(0);
        expect(refreshCalls).toEqual([]);
    });
});

describe("testAccount over an expired subscription account", () => {
    test("binding for a test reports the failure and spends no grant", async () => {
        const before = readFileSync(configPath(), "utf8");

        // bind() is reached even without --live, so this is the path a plain
        // `tools ai config account test <name>` takes.
        const result = await testAccount("expired-sub");

        expect(refreshCalls).toEqual([]);
        expect(result.binding.ok).toBe(false);
        expect(result.binding.detail).toContain("tools claude login expired-sub");
        expect(result.ok).toBe(false);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(await storedRefreshToken()).toBe("sk-ant-ort01-single-use");
    });

    test("--live adds the health probe and still spends no grant", async () => {
        const result = await testAccount("expired-sub", { live: true });

        expect(refreshCalls).toEqual([]);
        expect(result.health?.ok).toBe(false);
        expect(result.health?.detail).toContain("tools claude login expired-sub");
    });
});

describe("real use still refreshes", () => {
    /**
     * The guard must be scoped to diagnosis. If `noRefresh` leaked into the
     * normal path, every subscription account would stop working the moment its
     * access token aged out, which is a far worse bug than the one being fixed.
     */
    test("a bind without probe still reaches the refresh call", async () => {
        const plugin = providerPlugin("anthropic-sub");
        const account = (await AiConfigStore.load()).account("expired-sub");
        if (!account) {
            throw new Error("fixture account missing");
        }

        await expect(plugin.bind({ account })).rejects.toThrow(
            "a diagnostic probe must never reach claudeOAuth.refresh"
        );
        expect(refreshCalls).toEqual(["sk-ant-ort01-single-use"]);
    });
});

/**
 * The other plugins whose probe paths can mutate durable state. Each gets the
 * pair CLAUDE.md requires: the probe changes nothing, and a negative control
 * proves normal use still reaches the mutation.
 *
 * The spy here is `globalThis.fetch`, because every one of these grants is spent
 * by a network call — the OIDC grant for grok, the token POST for codex, the
 * session mint for copilot. It throws as well as records, so a probe that
 * reaches it fails loudly instead of passing quietly.
 */
function expiredJwt(): string {
    const payload = Buffer.from(SafeJSON.stringify({ exp: Math.floor((Date.now() - HOUR) / 1000) })).toString(
        "base64url"
    );

    return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

let fetchCalls: string[];
let realFetch: typeof globalThis.fetch;

function spyOnFetch(): void {
    fetchCalls = [];
    realFetch = globalThis.fetch;
    // `preconnect` on the real fetch type has no counterpart here, so the cast
    // goes through unknown rather than pretending the shapes overlap.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input instanceof Request ? input.url : input));
        throw new Error("a diagnostic probe must never reach the network to spend a grant");
    }) as unknown as typeof globalThis.fetch;
}

async function loadAccount(name: string): Promise<AccountEntry> {
    const entry = (await AiConfigStore.load()).account(name);

    if (!entry) {
        throw new Error(`fixture account "${name}" missing`);
    }

    return entry;
}

describe("grok-sub probe purity", () => {
    let authPath: string;

    beforeEach(async () => {
        authPath = join(home, "grok-auth.json");
        writeFileSync(
            authPath,
            SafeJSON.stringify({
                default: {
                    key: expiredJwt(),
                    refresh_token: "grok-single-use-rt",
                    oidc_issuer: "https://issuer.invalid",
                    oidc_client_id: "grok-cli",
                },
            })
        );
        await seed([
            account({
                id: "acc_grok",
                name: "grok-main",
                provider: "grok-sub",
                credentials: { authFile: authPath },
            }),
        ]);
        spyOnFetch();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test("health reports the expiry without the OIDC grant or rewriting auth.json", async () => {
        const before = readFileSync(authPath, "utf8");
        const plugin = providerPlugin("grok-sub");

        const health = await plugin.health?.({ account: await loadAccount("grok-main") });

        expect(fetchCalls).toEqual([]);
        expect(health?.ok).toBe(false);
        expect(health?.detail).toContain("refresh is disabled for diagnosis");
        expect(readFileSync(authPath, "utf8")).toBe(before);
    });

    test("negative control: a bind without probe still attempts the OIDC grant", async () => {
        const plugin = providerPlugin("grok-sub");

        await expect(plugin.bind({ account: await loadAccount("grok-main") })).rejects.toThrow();
        expect(fetchCalls.length).toBeGreaterThan(0);
    });
});

describe("openai-sub probe purity", () => {
    beforeEach(async () => {
        await seed([
            account({
                id: "acc_codex",
                name: "codex-main",
                provider: "openai-sub",
                credentials: {
                    accessToken: "codex-stale-at",
                    refreshToken: "codex-single-use-rt",
                    expiresAt: Date.now() - HOUR,
                },
            }),
        ]);
        spyOnFetch();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test("health reports the expiry and spends no grant", async () => {
        const before = readFileSync(configPath(), "utf8");
        const plugin = providerPlugin("openai-sub");

        const health = await plugin.health?.({ account: await loadAccount("codex-main") });

        expect(fetchCalls).toEqual([]);
        expect(health?.ok).toBe(false);
        expect(health?.detail).toContain("codex login");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("negative control: a bind without probe still reaches the refresh", async () => {
        const plugin = providerPlugin("openai-sub");

        await expect(plugin.bind({ account: await loadAccount("codex-main") })).rejects.toThrow();
        expect(fetchCalls.length).toBeGreaterThan(0);
    });
});

describe("github-copilot probe purity", () => {
    let dataDir: string;
    let sessionPath: string;

    beforeEach(async () => {
        dataDir = join(home, "copilot");
        sessionPath = join(dataDir, "session.json");
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, "github_token"), "gho_fixture\n");
        writeFileSync(
            sessionPath,
            SafeJSON.stringify({
                token: "tid=stale",
                expiresAtMs: Date.now() - HOUR,
                apiBaseUrl: "https://api.githubcopilot.invalid",
                refreshedAt: new Date(Date.now() - HOUR).toISOString(),
            })
        );
        await seed([
            account({
                id: "acc_copilot",
                name: "copilot-main",
                provider: "github-copilot",
                credentials: { dataDir },
            }),
        ]);
        spyOnFetch();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test("health reports the stale session without minting a new one", async () => {
        const before = readFileSync(sessionPath, "utf8");
        const plugin = providerPlugin("github-copilot");

        const health = await plugin.health?.({ account: await loadAccount("copilot-main") });

        expect(fetchCalls).toEqual([]);
        expect(health?.ok).toBe(false);
        expect(health?.detail).toContain("minting is disabled");
        expect(readFileSync(sessionPath, "utf8")).toBe(before);
        // Real use moves this file into auth storage and deletes it; the guard
        // sits above that call, so a probe must leave it exactly where it was.
        expect(existsSync(join(dataDir, "github_token"))).toBe(true);
    });

    test("a probe bind proves the session without minting, and leaves the cache alone", async () => {
        const before = readFileSync(sessionPath, "utf8");
        const plugin = providerPlugin("github-copilot");

        await expect(plugin.bind({ account: await loadAccount("copilot-main"), probe: true })).rejects.toThrow(
            "minting is disabled"
        );
        expect(fetchCalls).toEqual([]);
        expect(readFileSync(sessionPath, "utf8")).toBe(before);
        expect(existsSync(join(dataDir, "github_token"))).toBe(true);
    });

    test("negative control: real use still mints a session", async () => {
        await expect(getCopilotSession(dataDir)).rejects.toThrow();
        expect(fetchCalls.length).toBeGreaterThan(0);
    });
});
