import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountsAllowEnv, runAccountsFailover, runAccountsSetKey } from "@app/ai-proxy/commands/accounts";
import { codexProxyAccount } from "@app/ai-proxy/commands/accounts-login";
import { runSessionUse } from "@app/ai-proxy/commands/session-use";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { codexAccountAuthStatus, runAccountsBind } from "@app/ai-proxy/lib/providers/codex/account-commands";
import { runAccountsSetRouting } from "@app/ai-proxy/lib/providers/openrouter/account-commands";
import { agentLogins } from "@app/ai-proxy/lib/sessions/accounts";
import { closeSessionRecord, createSessionRecord, readSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * These cover the non-interactive halves of `accounts set-key` / `allow-env` —
 * the ones that decide, without a human in the loop, whether an account may
 * spend a billed key. The clack chooser itself is not driven here; every state
 * it can leave behind is reachable through these two entry points.
 *
 * `isInteractive()` is false under the test runner (no TTY), which is exactly
 * the branch a script or a daemon takes.
 */

const originalHome = env.get("GENESIS_TOOLS_HOME");
let tempDir: string;

function account(overrides: Partial<AiProxyAccountConfig> = {}): AiProxyAccountConfig {
    return { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true, ...overrides };
}

async function seed(...accounts: AiProxyAccountConfig[]): Promise<void> {
    const config = await loadConfig();
    config.accounts = accounts;
    await saveConfig(config);
}

async function readAccount(name: string): Promise<AiProxyAccountConfig | undefined> {
    return (await loadConfig()).accounts.find((item) => item.name === name);
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-accounts-"));
    env.testing.set("GENESIS_TOOLS_HOME", tempDir);
    resetAiProxyConfigStore();
    resetAiProxyStorage();
});

afterEach(() => {
    resetAiProxyConfigStore();
    resetAiProxyStorage();
    rmSync(tempDir, { recursive: true, force: true });

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("runAccountsSetKey", () => {
    it("stores a key given on argv and drops any environment opt-in", async () => {
        await seed(account({ allowEnvApiKey: true }));

        await runAccountsSetKey("work", "xai-secret-value");

        const stored = await readAccount("work");
        expect(stored?.apiKey).toBe("xai-secret-value");
        // Both fields set would claim two different intentions; the stored key
        // wins at resolve time, so the opt-in has to go.
        expect(stored?.allowEnvApiKey).toBeUndefined();
    });

    it("trims the key so a stray space cannot become part of the credential", async () => {
        await seed(account());

        await runAccountsSetKey("work", "  xai-secret-value  ");

        expect((await readAccount("work"))?.apiKey).toBe("xai-secret-value");
    });

    it("changes nothing for an OAuth account, which has no api key to set", async () => {
        await seed(account({ name: "grok", provider: "grok-subscription", providerSlug: "grok" }));

        await runAccountsSetKey("grok", "should-not-land");

        expect((await readAccount("grok"))?.apiKey).toBeUndefined();
    });

    it("changes nothing for an account that does not exist", async () => {
        await seed(account());

        await runAccountsSetKey("missing", "should-not-land");

        expect((await loadConfig()).accounts).toHaveLength(1);
        expect((await readAccount("work"))?.apiKey).toBeUndefined();
    });

    it("leaves the account untouched when no key is given and there is no terminal to ask on", async () => {
        await seed(account({ apiKey: "existing-key" }));

        await runAccountsSetKey("work", undefined);

        expect((await readAccount("work"))?.apiKey).toBe("existing-key");
    });
});

describe("runAccountsAllowEnv", () => {
    it("opts the account in and removes a stored key that would have won anyway", async () => {
        await seed(account({ apiKey: "stored-key" }));

        await runAccountsAllowEnv("work", true);

        const stored = await readAccount("work");
        expect(stored?.allowEnvApiKey).toBe(true);
        expect(stored?.apiKey).toBeUndefined();
    });

    it("revokes the opt-in, leaving the account with no credential at all", async () => {
        await seed(account({ allowEnvApiKey: true }));

        await runAccountsAllowEnv("work", false);

        const stored = await readAccount("work");
        expect(stored?.allowEnvApiKey).toBeUndefined();
        expect(stored?.apiKey).toBeUndefined();
    });

    it("refuses to opt in an OAuth account", async () => {
        await seed(account({ name: "grok", provider: "grok-subscription", providerSlug: "grok" }));

        await runAccountsAllowEnv("grok", true);

        expect((await readAccount("grok"))?.allowEnvApiKey).toBeUndefined();
    });

    it("--env points the account at a custom variable name", async () => {
        await seed(account({ provider: "openrouter", providerSlug: "openrouter" }));

        await runAccountsAllowEnv("work", true, { envName: "GT_OPENROUTER_API_KEY" });

        const stored = await readAccount("work");
        expect(stored?.allowEnvApiKey).toBe(true);
        expect(stored?.apiKeyEnv).toBe("GT_OPENROUTER_API_KEY");
    });

    it("--env replaces a previously-named variable", async () => {
        await seed(account({ provider: "openrouter", providerSlug: "openrouter", apiKeyEnv: "OLD_KEY_NAME" }));

        await runAccountsAllowEnv("work", true, { envName: "NEW_KEY_NAME" });

        expect((await readAccount("work"))?.apiKeyEnv).toBe("NEW_KEY_NAME");
    });

    it("--env is refused together with --off — there is nothing to opt a variable into", async () => {
        await seed(account({ provider: "openrouter", providerSlug: "openrouter" }));

        await runAccountsAllowEnv("work", false, { envName: "GT_OPENROUTER_API_KEY" });

        expect((await readAccount("work"))?.apiKeyEnv).toBeUndefined();
        expect((await readAccount("work"))?.allowEnvApiKey).toBeUndefined();
    });
});

function openrouterAccount(overrides: Partial<AiProxyAccountConfig> = {}): AiProxyAccountConfig {
    return account({ name: "router", provider: "openrouter", providerSlug: "openrouter", ...overrides });
}

describe("runAccountsSetRouting", () => {
    it("writes a provider pin onto an account with no prior routing config", async () => {
        await seed(openrouterAccount());

        await runAccountsSetRouting("router", { order: ["Morph", "DeepInfra"], allowFallbacks: false }, {});

        const stored = await readAccount("router");
        expect(stored?.openrouter?.provider).toEqual({ order: ["Morph", "DeepInfra"], allow_fallbacks: false });
    });

    it("merges into an existing routing config without clobbering the models filter", async () => {
        await seed(
            openrouterAccount({
                openrouter: {
                    models: { include: ["anthropic/*"] },
                    provider: { order: ["Morph"], allow_fallbacks: false },
                },
            })
        );

        await runAccountsSetRouting("router", { ignore: ["Together"] }, {});

        const stored = await readAccount("router");
        expect(stored?.openrouter?.models).toEqual({ include: ["anthropic/*"] });
        // order/allow_fallbacks were not part of this patch and must survive.
        expect(stored?.openrouter?.provider).toEqual({
            order: ["Morph"],
            allow_fallbacks: false,
            ignore: ["Together"],
        });
    });

    it("sets the fallbackModels list independently of the provider block", async () => {
        await seed(openrouterAccount());

        await runAccountsSetRouting("router", { fallbackModels: ["a/b", "c/d"] }, {});

        const stored = await readAccount("router");
        expect(stored?.openrouter?.fallbackModels).toEqual(["a/b", "c/d"]);
        // No provider fields were patched and none pre-existed — no stray `provider: {}`.
        expect(stored?.openrouter?.provider).toBeUndefined();
    });

    it("--clear removes the pin but keeps an unrelated models filter", async () => {
        await seed(
            openrouterAccount({
                openrouter: {
                    models: { include: ["anthropic/*"] },
                    provider: { order: ["Morph"], allow_fallbacks: false },
                    fallbackModels: ["a/b"],
                },
            })
        );

        await runAccountsSetRouting("router", {}, { clear: true });

        const stored = await readAccount("router");
        expect(stored?.openrouter?.provider).toBeUndefined();
        expect(stored?.openrouter?.fallbackModels).toBeUndefined();
        expect(stored?.openrouter?.models).toEqual({ include: ["anthropic/*"] });
    });

    it("--clear drops the whole openrouter block when nothing else is left", async () => {
        await seed(openrouterAccount({ openrouter: { provider: { order: ["Morph"] } } }));

        await runAccountsSetRouting("router", {}, { clear: true });

        expect((await readAccount("router"))?.openrouter).toBeUndefined();
    });

    it("changes nothing when no routing fields and no --clear are given", async () => {
        await seed(openrouterAccount({ openrouter: { provider: { order: ["Morph"] } } }));

        await runAccountsSetRouting("router", {}, {});

        expect((await readAccount("router"))?.openrouter?.provider).toEqual({ order: ["Morph"] });
    });

    it("refuses to pin routing on a non-openrouter account", async () => {
        await seed(account({ provider: "xai-api-key" }));

        await runAccountsSetRouting("work", { order: ["Morph"] }, {});

        expect((await readAccount("work"))?.openrouter).toBeUndefined();
    });

    it("changes nothing for an account that does not exist", async () => {
        await seed(openrouterAccount());

        await runAccountsSetRouting("missing", { order: ["Morph"] }, {});

        expect((await loadConfig()).accounts).toHaveLength(1);
    });
});

describe("runAccountsSetRouting --match (per-model routes)", () => {
    it("--match adds a route without touching the account-level default", async () => {
        await seed(openrouterAccount({ openrouter: { provider: { sort: "price" } } }));

        await runAccountsSetRouting(
            "router",
            { order: ["Morph", "DeepInfra"], allowFallbacks: false },
            { match: "moonshotai/kimi-k3" }
        );

        const stored = await readAccount("router");
        expect(stored?.openrouter?.provider).toEqual({ sort: "price" });
        expect(stored?.openrouter?.routes).toEqual([
            { match: "moonshotai/kimi-k3", provider: { order: ["Morph", "DeepInfra"], allow_fallbacks: false } },
        ]);
    });

    it("--match with an existing route name updates that route in place, preserving the rest", async () => {
        await seed(
            openrouterAccount({
                openrouter: {
                    routes: [
                        { match: "moonshotai/kimi-k3", provider: { order: ["Morph"], allow_fallbacks: false } },
                        { match: "deepseek/*", provider: { sort: "price" } },
                    ],
                },
            })
        );

        await runAccountsSetRouting("router", { ignore: ["Together"] }, { match: "deepseek/*" });

        const stored = await readAccount("router");
        expect(stored?.openrouter?.routes).toEqual([
            { match: "moonshotai/kimi-k3", provider: { order: ["Morph"], allow_fallbacks: false } },
            { match: "deepseek/*", provider: { sort: "price", ignore: ["Together"] } },
        ]);
    });

    it("--match --clear drops only that one route", async () => {
        await seed(
            openrouterAccount({
                openrouter: {
                    routes: [
                        { match: "moonshotai/kimi-k3", provider: { order: ["Morph"], allow_fallbacks: false } },
                        { match: "deepseek/*", provider: { sort: "price" } },
                    ],
                },
            })
        );

        await runAccountsSetRouting("router", {}, { match: "moonshotai/kimi-k3", clear: true });

        expect((await readAccount("router"))?.openrouter?.routes).toEqual([
            { match: "deepseek/*", provider: { sort: "price" } },
        ]);
    });

    it("--match --clear on the last route drops the routes key entirely", async () => {
        await seed(
            openrouterAccount({
                openrouter: { routes: [{ match: "moonshotai/kimi-k3", provider: { order: ["Morph"] } }] },
            })
        );

        await runAccountsSetRouting("router", {}, { match: "moonshotai/kimi-k3", clear: true });

        expect((await readAccount("router"))?.openrouter?.routes).toBeUndefined();
    });

    it("--match --clear on a route that does not exist warns and changes nothing", async () => {
        await seed(
            openrouterAccount({
                openrouter: { routes: [{ match: "moonshotai/kimi-k3", provider: { order: ["Morph"] } }] },
            })
        );

        await runAccountsSetRouting("router", {}, { match: "qwen/*", clear: true });

        expect((await readAccount("router"))?.openrouter?.routes).toEqual([
            { match: "moonshotai/kimi-k3", provider: { order: ["Morph"] } },
        ]);
    });

    it("--match with no routing fields and no --clear changes nothing", async () => {
        await seed(
            openrouterAccount({
                openrouter: { routes: [{ match: "moonshotai/kimi-k3", provider: { order: ["Morph"] } }] },
            })
        );

        await runAccountsSetRouting("router", {}, { match: "moonshotai/kimi-k3" });

        expect((await readAccount("router"))?.openrouter?.routes).toEqual([
            { match: "moonshotai/kimi-k3", provider: { order: ["Morph"] } },
        ]);
    });
});

describe("codex accounts: one auth engine", () => {
    /** An AI-config `openai-sub` login with no credentials: enough for `bind` to find it, nothing to migrate. */
    function seedCodexLogins(...names: string[]): void {
        const data: AiConfigData = {
            version: CONFIG_VERSION,
            defaults: {},
            accounts: names.map((name) => ({
                id: `acc_${name}`,
                name,
                provider: "openai-sub",
                enabled: true,
                billing: { mode: "subscription" },
                credentials: {},
                useEnvApiKey: false,
            })),
        };
        mkdirSync(join(tempDir, ".genesis-tools", "ai"), { recursive: true });
        writeFileSync(join(tempDir, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(data, null, 2));
        AiConfigStore.invalidate();
    }

    const legacy = account({ name: "codex", provider: "openai-subscription", providerSlug: "codex" });

    afterEach(() => {
        AiConfigStore.invalidate();
        process.exitCode = 0;
    });

    it("bind points a legacy codex account at a managed login and drops the CLI-cache path", async () => {
        seedCodexLogins("personal", "work");
        await seed({ ...legacy, openaiSub: { codexAuthPath: "/somewhere/auth.json", defaultReasoningEffort: "high" } });

        await runAccountsBind("codex", { codex: "work" });

        expect((await readAccount("codex"))?.openaiSub).toEqual({
            accountName: "work",
            defaultReasoningEffort: "high",
        });
    });

    it("bind refuses a login that does not exist and changes nothing", async () => {
        seedCodexLogins("personal");
        await seed(legacy);

        await runAccountsBind("codex", { codex: "shop" });

        expect(process.exitCode).toBe(1);
        expect((await readAccount("codex"))?.openaiSub).toBeUndefined();
    });

    it("bind refuses an account that is not a codex account", async () => {
        seedCodexLogins("personal");
        await seed(account());

        await runAccountsBind("work", { codex: "personal" });

        expect(process.exitCode).toBe(1);
        expect((await readAccount("work"))?.openaiSub).toBeUndefined();
        process.exitCode = 0;
        await runAccountsBind("missing", { codex: "personal" });
        expect(process.exitCode).toBe(1);
    });

    it("failover is off by default; on and off set and clear it; a non-codex account is refused", async () => {
        await seed({ ...legacy, openaiSub: { failoverAccountNames: ["work"] } }, account());

        await runAccountsFailover("codex", "on");
        const on = (await readAccount("codex"))?.failover;
        await runAccountsFailover("codex", "off");
        const off = (await readAccount("codex"))?.failover;
        await runAccountsFailover("work", "on");

        expect([on, off]).toEqual([true, undefined]);
        expect(process.exitCode).toBe(1);
        expect((await readAccount("work"))?.failover).toBeUndefined();
    });

    it("session use moves an agent to another login and records the move; the next request reads it", async () => {
        seedCodexLogins("personal", "work");
        await seed(legacy);
        createSessionRecord({ id: "s-use", codexAccount: "personal" });

        await runSessionUse("s-use", { codex: "work" });

        const record = readSessionRecord("s-use");
        expect(process.exitCode).toBe(0);
        expect([record?.codexAccount, record?.codexProxyAccount]).toEqual(["work", undefined]);
        expect(record?.moves).toEqual([{ agent: "codex", from: "personal", to: "work", at: expect.any(String) }]);

        // A configured proxy account (the legacy auth.json one) works too, and replaces the login.
        await runSessionUse("s-use", { codex: "codex" });
        expect([readSessionRecord("s-use")?.codexProxyAccount, readSessionRecord("s-use")?.codexAccount]).toEqual([
            "codex",
            undefined,
        ]);
    });

    it("session use refuses a per-token account without --allow-metered, and a closed session", async () => {
        seedCodexLogins("personal");
        await seed(account({ name: "billed" }));
        createSessionRecord({ id: "s-metered", codexAccount: "personal" });

        await runSessionUse("s-metered", { grok: "billed" });
        const refused = readSessionRecord("s-metered");
        process.exitCode = 0;
        await runSessionUse("s-metered", { grok: "billed", allowMetered: ["billed"] });
        const allowed = readSessionRecord("s-metered");
        closeSessionRecord({ id: "s-metered" });
        await runSessionUse("s-metered", { codex: "personal" });

        expect(refused?.grokProxyAccount).toBeUndefined();
        expect(allowed?.grokProxyAccount).toBe("billed");
        expect(allowed?.meteredConfirmed.map((item) => [item.account, item.how])).toEqual([["billed", "flag"]]);
        expect(process.exitCode).toBe(1);
        expect(readSessionRecord("s-metered")?.moves).toHaveLength(1);
    });

    it("status names the legacy read of the Codex CLI login, and never refreshes", async () => {
        const missing = join(tempDir, "no-auth.json");
        const status = await codexAccountAuthStatus({ ...legacy, openaiSub: { codexAuthPath: missing } });

        expect(status).toEqual({
            source: `legacy Codex CLI login (${missing}, read-only)`,
            plan: undefined,
            expiresAt: undefined,
            error: "no token",
        });
        expect(status.login).toBeUndefined();
    });
});

describe("session logins per agent", () => {
    afterEach(() => {
        AiConfigStore.invalidate();
    });

    it("lists each agent's enabled logins from that agent's own AI-config provider", async () => {
        const login = (name: string, provider: string, enabled = true) => ({
            id: `acc_${name}`,
            name,
            provider,
            enabled,
            billing: { mode: provider === "xai" ? "metered" : "subscription" },
            credentials: {},
            useEnvApiKey: false,
        });
        const data = {
            version: CONFIG_VERSION,
            defaults: {},
            accounts: [
                login("codex-a", "openai-sub"),
                login("codex-off", "openai-sub", false),
                login("claude-a", "anthropic-sub"),
                login("grok-a", "grok-sub"),
                login("xai-key", "xai"),
            ],
        };
        mkdirSync(join(tempDir, ".genesis-tools", "ai"), { recursive: true });
        writeFileSync(join(tempDir, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(data, null, 2));
        AiConfigStore.invalidate();
        const store = await AiConfigStore.load();
        const names = (agent: "codex" | "claude" | "grok") => agentLogins(store, agent).map((entry) => entry.name);

        expect({ codex: names("codex"), claude: names("claude"), grok: names("grok") }).toEqual({
            codex: ["codex-a"],
            claude: ["claude-a"],
            grok: ["grok-a"],
        });
    });
});

describe("accounts login codex: the proxy account of a Codex login", () => {
    const codex = (name: string, login: string, enabled = true): AiProxyAccountConfig => ({
        name,
        provider: "openai-subscription",
        providerSlug: "codex",
        enabled,
        openaiSub: { accountName: login },
    });

    it("enables the account that already references the login, and adds nothing", () => {
        const accounts = [codex("codex", "alice", false)];

        expect(codexProxyAccount(accounts, "alice", "plus")).toEqual({
            account: codex("codex", "alice"),
            added: false,
        });
        expect(accounts).toEqual([codex("codex", "alice")]);
    });

    it("adds a codex account for a new login, named after the login when codex is taken", () => {
        const grok: AiProxyAccountConfig = {
            name: "grok",
            provider: "grok-subscription",
            providerSlug: "grok",
            enabled: true,
            grok: { accountName: "alice" },
        };
        const empty: AiProxyAccountConfig[] = [grok];
        const taken = [codex("codex", "bob")];

        expect([codexProxyAccount(empty, "alice", undefined), codexProxyAccount(taken, "alice", "plus")]).toEqual([
            { account: { ...codex("codex", "alice"), label: "Codex" }, added: true },
            { account: { ...codex("codex-alice", "alice"), label: "Codex (plus)" }, added: true },
        ]);
        expect(empty.map((account) => account.name)).toEqual(["grok", "codex"]);
        expect(taken.map((account) => account.name)).toEqual(["codex", "codex-alice"]);
    });
});
