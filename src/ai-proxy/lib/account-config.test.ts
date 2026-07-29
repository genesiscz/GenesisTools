import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    accountBindingFingerprint,
    accountConfigFingerprint,
    migrateAccountConfig,
    resolveGithubCopilotDataDir,
    resolveGrokAuthPath,
} from "@app/ai-proxy/lib/account-config";
import { parseConfigJson } from "@app/ai-proxy/lib/config-store";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { _resetSecretsForTest, invalidateMasterKeyCache, secrets } from "@genesiscz/utils/security";

const baseAccount: AiProxyAccountConfig = {
    name: "genesiscz",
    provider: "grok-subscription",
    providerSlug: "grok",
    enabled: true,
};

describe("account-config", () => {
    it("resolves grok auth path from nested config", () => {
        const account: AiProxyAccountConfig = {
            ...baseAccount,
            grok: { authPath: join(tmpdir(), "grok", "auth.json") },
        };

        expect(resolveGrokAuthPath(account)).toBe(join(tmpdir(), "grok", "auth.json"));
    });

    it("migrates legacy flat grok and copilot fields", () => {
        const migrated = migrateAccountConfig({
            ...baseAccount,
            provider: "github-copilot-subscription",
            providerSlug: "github-copilot",
            grokAuthPath: "/legacy/grok.json",
            copilotDataDir: "/legacy/copilot",
            copilotAccountType: "business",
        });

        expect(migrated.grok).toEqual({ authPath: "/legacy/grok.json" });
        expect(migrated.githubCopilot).toEqual({ dataDir: "/legacy/copilot", type: "business" });
        expect("grokAuthPath" in migrated).toBe(false);
        expect("copilotDataDir" in migrated).toBe(false);
        expect("copilotAccountType" in migrated).toBe(false);
    });

    it("resolves github copilot data dir from nested config", () => {
        const account: AiProxyAccountConfig = {
            ...baseAccount,
            provider: "github-copilot-subscription",
            providerSlug: "github-copilot",
            githubCopilot: { dataDir: join(tmpdir(), "copilot-api") },
        };

        expect(resolveGithubCopilotDataDir(account)).toBe(join(tmpdir(), "copilot-api"));
    });

    it("migrates legacy fields when parsing config json", () => {
        const config = parseConfigJson(
            '{"accounts":[{"name":"genesiscz","provider":"grok-subscription","providerSlug":"grok","enabled":true,"grokAuthPath":"/old/auth.json"}]}'
        );

        expect(config.accounts[0]?.grok).toEqual({ authPath: "/old/auth.json" });
        expect("grokAuthPath" in (config.accounts[0] ?? {})).toBe(false);
    });
});

const VAULT_PATH = "ai/acc_proxy_openai/apiKey";

const vaultedAccount: AiProxyAccountConfig = {
    name: "openai-metered",
    provider: "openai",
    providerSlug: "openai",
    enabled: true,
    account: "@account/acc_proxy_openai",
};

function writeAiConfig(home: string): void {
    const config = {
        version: CONFIG_VERSION,
        accounts: [
            {
                id: "acc_proxy_openai",
                name: "openai-metered",
                provider: "openai",
                enabled: true,
                billing: { mode: "metered" },
                credentials: { apiKey: { type: "secure", path: VAULT_PATH } },
                useEnvApiKey: false,
            },
        ],
        defaults: {},
    };

    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(config, null, 2));
}

describe("accountBindingFingerprint", () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "gt-proxy-fingerprint-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        env.testing.set("GENESIS_TOOLS_MASTER_KEY", randomBytes(32).toString("base64"));
        writeAiConfig(home);
        _resetSecretsForTest();
        invalidateMasterKeyCache();
        AiConfigStore.invalidate();
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        env.testing.unset("GENESIS_TOOLS_MASTER_KEY");
        _resetSecretsForTest();
        invalidateMasterKeyCache();
        AiConfigStore.invalidate();
        rmSync(home, { recursive: true, force: true });
    });

    /**
     * Why this fingerprint exists at all: `accountConfigFingerprint` sees only
     * ai-proxy's own config, so a token rotated into the vault left a
     * long-running `serve` holding a provider built from the old secret until
     * someone restarted the process.
     */
    it("changes when a vault secret is rotated, while the config hash does not", async () => {
        const store = await secrets();
        await store.set(VAULT_PATH, "sk-first");

        const before = await accountBindingFingerprint(vaultedAccount);
        const configHashBefore = accountConfigFingerprint(vaultedAccount);

        await store.set(VAULT_PATH, "sk-rotated");

        expect(await accountBindingFingerprint(vaultedAccount)).not.toBe(before);
        expect(accountConfigFingerprint(vaultedAccount)).toBe(configHashBefore);
    });

    it("is stable when nothing changed", async () => {
        await (await secrets()).set(VAULT_PATH, "sk-first");

        expect(await accountBindingFingerprint(vaultedAccount)).toBe(await accountBindingFingerprint(vaultedAccount));
    });

    it("never carries the secret value itself", async () => {
        await (await secrets()).set(VAULT_PATH, "sk-super-secret-value");

        expect(await accountBindingFingerprint(vaultedAccount)).not.toContain("sk-super-secret");
    });
});
