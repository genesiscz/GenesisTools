import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { __resetUsagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import { claudeOAuth } from "@genesiscz/utils/claude/auth";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { collectHomes } from "./run-discover";
import { collectAccountRows } from "./run-list";
import { runShow } from "./run-show";
import { runWho } from "./run-who";

/**
 * `tools ai accounts list | show | discover | who` are DIAGNOSTICS.
 *
 * They read stored state and report on it. Reaching a refresh here would spend a
 * single-use grant to answer a question, which is exactly the bug `doctor` and
 * `account test` shipped with (`doctor-no-refresh.test.ts` pins those). Both
 * spies below THROW as well as record, so any such path fails loudly instead of
 * passing quietly, and each has a negative control proving real use still gets
 * through.
 *
 * This suite lives under `src/ai/` rather than beside `doctor-no-refresh.test.ts`
 * because `src/utils/**` resolves as the `@genesiscz/utils` package and cannot
 * import `@app/*` at runtime.
 */

const KEY = Buffer.alloc(32, 5);
const HOUR = 60 * 60 * 1000;

let home: string;
let refreshCalls: string[];
let realRefresh: typeof claudeOAuth.refresh;
let fetchCalls: string[];
let realFetch: typeof globalThis.fetch;

function expiredAnthropicAccount(): AccountEntry {
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
        accountUuid: "acct-stored",
        organizationUuid: "org-stored",
    };
}

function expiredJwt(): string {
    const payload = Buffer.from(
        SafeJSON.stringify({ exp: Math.floor((Date.now() - HOUR) / 1000), sub: "user-1" })
    ).toString("base64url");

    return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

/**
 * One recorded snapshot for `expired-sub`, in the all-provider cache `show` reads
 * (spec 6.4). The storage singleton memoises its directory, so it is reset here to
 * pick up this test's `GENESIS_TOOLS_HOME`.
 */
function writeSnapshotsFixture(): void {
    __resetUsagePollStorage();
    const dir = join(home, ".genesis-tools", "ai-usage", "cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "snapshots.json"),
        SafeJSON.stringify({
            fetchedAt: new Date().toISOString(),
            providers: {
                "anthropic-sub": {
                    alias: "claude",
                    displayName: "Claude",
                    prominent: ["five_hour"],
                    accounts: [
                        {
                            provider: "anthropic-sub",
                            accountId: "acc_expired",
                            accountName: "expired-sub",
                            fetchedAt: new Date().toISOString(),
                            limits: [{ key: "five_hour", label: "5h", kind: "session", percentUsed: 42 }],
                        },
                    ],
                },
            },
        })
    );
}

/** Seed and let the vault migration settle, so a later byte check measures only the probe. */
async function seed(accounts: AccountEntry[]): Promise<void> {
    const data: AiConfigData = { version: CONFIG_VERSION, accounts, defaults: {} };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AIConfig.invalidate();
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-accounts-probe-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    registerBuiltInPlugins();
    await seed([expiredAnthropicAccount()]);

    refreshCalls = [];
    realRefresh = claudeOAuth.refresh.bind(claudeOAuth);
    claudeOAuth.refresh = async (refreshToken: string) => {
        refreshCalls.push(refreshToken);
        throw new Error("a diagnostic must never reach claudeOAuth.refresh");
    };

    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input instanceof Request ? input.url : input));
        throw new Error("a diagnostic must never reach the network to spend a grant");
    }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
    claudeOAuth.refresh = realRefresh;
    globalThis.fetch = realFetch;
    // The storage memoises its cache directory. Left set, the next test would read
    // THIS test's snapshots file out of a home that no longer belongs to it.
    __resetUsagePollStorage();
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("GROK_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AIConfig.invalidate();
});

describe("accounts list", () => {
    test("reports an expired account and performs zero refresh attempts", async () => {
        const before = readFileSync(configPath(), "utf8");

        const rows = await collectAccountRows("anthropic-sub");

        expect(refreshCalls).toEqual([]);
        expect(fetchCalls).toEqual([]);
        expect(rows.map((row) => row.name)).toEqual(["expired-sub"]);
        expect(rows[0].credentialKinds).toEqual(["accessToken", "refreshToken"]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("emits which credential kinds exist, never a credential VALUE", async () => {
        const serialised = SafeJSON.stringify(await collectAccountRows("anthropic-sub"));

        expect(serialised).toContain("accessToken");
        expect(serialised).not.toContain("sk-ant-oat01-stale");
        expect(serialised).not.toContain("sk-ant-ort01-single-use");
    });
});

describe("accounts show", () => {
    test("reads identity off the account and performs zero refresh attempts", async () => {
        const before = readFileSync(configPath(), "utf8");

        await runShow({ name: "expired-sub", json: true, tool: "tools ai accounts show" });

        expect(refreshCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    // NEGATIVE CONTROL for the usage section: the snapshot really is reported, and
    // reporting it still costs no grant. `show` reads the recorded cache rather than
    // `UsageLimitsDb`, whose constructor would CREATE and migrate tables — a write.
    test("reports the recorded snapshot without polling, refreshing or opening a database", async () => {
        writeSnapshotsFixture();
        const before = readFileSync(configPath(), "utf8");
        const printed: unknown[] = [];
        const realResult = out.result;
        out.result = ((value: unknown) => {
            printed.push(value);
        }) as typeof out.result;

        try {
            await runShow({ name: "expired-sub", json: true, tool: "tools ai accounts show" });
        } finally {
            out.result = realResult;
        }

        const detail = printed[0] as { lastUsage: { accountName: string; limits: Array<{ key: string }> } | null };
        expect(detail.lastUsage?.accountName).toBe("expired-sub");
        expect(detail.lastUsage?.limits.map((window) => window.key)).toEqual(["five_hour"]);
        expect(refreshCalls).toEqual([]);
        expect(fetchCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(existsSync(join(home, ".genesis-tools", "claude", "usage.db"))).toBe(false);
    });

    test("an account with nothing recorded reports null rather than failing", async () => {
        const printed: unknown[] = [];
        const realResult = out.result;
        out.result = ((value: unknown) => {
            printed.push(value);
        }) as typeof out.result;

        try {
            await runShow({ name: "expired-sub", json: true, tool: "tools ai accounts show" });
        } finally {
            out.result = realResult;
        }

        expect((printed[0] as { lastUsage: unknown }).lastUsage).toBeNull();
        expect(fetchCalls).toEqual([]);
    });
});

describe("accounts who", () => {
    test("lists processes without touching a credential", async () => {
        const before = readFileSync(configPath(), "utf8");

        await runWho({ json: true });

        expect(refreshCalls).toEqual([]);
        expect(fetchCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    }, 30_000);
});

describe("accounts discover without --bind", () => {
    test("grok: decodes the stored claims, performs no OIDC grant, leaves auth.json byte-identical", async () => {
        const grokHome = join(home, "grok-home");
        const authFile = join(grokHome, "auth.json");
        mkdirSync(grokHome, { recursive: true });
        writeFileSync(
            authFile,
            SafeJSON.stringify({
                default: {
                    key: expiredJwt(),
                    refresh_token: "grok-single-use-rt",
                    oidc_issuer: "https://issuer.invalid",
                    oidc_client_id: "grok-cli",
                },
            })
        );
        const before = readFileSync(authFile, "utf8");
        env.testing.set("GROK_HOME", grokHome);

        const homes = await collectHomes("grok-sub");

        expect(homes.some((entry) => entry.home === grokHome)).toBe(true);
        expect(homes.find((entry) => entry.home === grokHome)?.identity?.accountUuid).toBe("user-1");
        expect(fetchCalls).toEqual([]);
        // The Grok CLI owns this file; a discovery that rewrote it would rotate a
        // grant we do not manage.
        expect(readFileSync(authFile, "utf8")).toBe(before);
    });

    test("codex: reads homes off disk without a token refresh or a config write", async () => {
        const before = readFileSync(configPath(), "utf8");

        await collectHomes("openai-sub");

        expect(fetchCalls).toEqual([]);
        expect(refreshCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("every provider at once still writes nothing", async () => {
        const before = readFileSync(configPath(), "utf8");

        await collectHomes();

        expect(refreshCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });
});

/**
 * The guard must be scoped to diagnosis. If it leaked into the normal path,
 * every subscription account would stop working the moment its access token aged
 * out — a worse bug than the one being fixed.
 */
describe("negative control: real use still reaches the refresh", () => {
    test("a bind without probe spends the grant", async () => {
        const { providerPlugin } = await import("@genesiscz/utils/ai/providers/registry");
        const account = (await AiConfigStore.load()).account("expired-sub");

        if (!account) {
            throw new Error("fixture account missing");
        }

        await expect(providerPlugin("anthropic-sub").bind({ account })).rejects.toThrow(
            "a diagnostic must never reach claudeOAuth.refresh"
        );
        expect(refreshCalls).toEqual(["sk-ant-ort01-single-use"]);
    });
});
