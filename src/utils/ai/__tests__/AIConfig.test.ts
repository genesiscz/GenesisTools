import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { _resetMasterKeyProviders, _setMasterKeyProvidersForTest } from "@genesiscz/utils/security/MasterKey";
import { _resetSecretsForTest, secrets, vaultAdmin } from "@genesiscz/utils/security/SecretStore";
import { AIConfig, mergeAccountEntry } from "../AIConfig";
import { AiConfigStore } from "../config/AiConfigStore";
import { aiDataDir } from "../config/paths";

describe("AIConfig", () => {
    // Without this sandbox these tests load and WRITE the user's real
    // ~/.genesis-tools/ai/config.json — `setAppDefaults("test-app", …)` below had
    // been persisting a `test-app` block into live config on every run.
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "gt-aiconfig-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        AIConfig.invalidate();
        _setMasterKeyProvidersForTest([
            {
                id: "keychain",
                available: async () => true,
                get: async () => Buffer.alloc(32, 7),
                getSync: () => Buffer.alloc(32, 7),
                set: async () => {},
            },
        ]);
        _resetSecretsForTest();
    });

    // Removed only AFTER the singleton is dropped: it holds a Storage bound to
    // this root. One sandbox per test, and each holds a config file full of
    // credential-shaped fixtures, so leaving them behind litters the temp
    // directory on every run.
    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        AIConfig.invalidate();
        _resetMasterKeyProviders();
        _resetSecretsForTest();
        rmSync(home, { recursive: true, force: true });
    });

    it("refreshes a held facade on canonical edits, external replacement and vault-only replacement", async () => {
        const store = await AiConfigStore.load();
        const vault = await secrets();
        const ref = await vault.set("ai/acc_work/longLivedToken", "fixture-first");
        await store.mutate((data) => {
            data.accounts = [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "anthropic-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    useEnvApiKey: false,
                    credentials: { longLivedToken: ref },
                },
            ];
        });
        const facade = await AIConfig.load();
        expect(facade.getAccount("work")?.tokens.longLivedToken).toBe("fixture-first");
        const unchanged = facade.getAccount("work");
        expect(await AIConfig.load()).toBe(facade);
        expect(facade.getAccount("work")).toEqual(unchanged);
        await vault.set(ref.path, "fixture-second");
        await AIConfig.load();
        expect(facade.getAccount("work")?.tokens.longLivedToken).toBe("fixture-second");
        await store.mutate((data) => {
            data.accounts[0].credentials = {};
        });
        await AIConfig.load();
        expect(facade.getAccount("work")?.tokens.longLivedToken).toBeUndefined();
        const replacement = structuredClone(store.data());
        replacement.accounts[0].credentials.longLivedToken = "fixture-external";
        // Another process writes the file: no AiConfigStore, no lock.
        await Bun.write(aiDataDir("config.json"), SafeJSON.stringify(replacement, null, 2));
        await AIConfig.load();
        expect(facade.getAccount("work")?.tokens.longLivedToken).toBe("fixture-external");
    });

    it("parses a vault once per projection and never again on unchanged loads", async () => {
        const store = await AiConfigStore.load();
        const vault = await secrets();
        const accessToken = await vault.set("ai/acc_work/accessToken", "fixture-access");
        const refreshToken = await vault.set("ai/acc_work/refreshToken", "fixture-refresh");
        const longLivedToken = await vault.set("ai/acc_work/longLivedToken", "fixture-long");
        await store.mutate((data) => {
            data.accounts = Array.from({ length: 12 }, (_, i) => ({
                id: `acc_fixture${i}`,
                name: `fixture${i}`,
                provider: "anthropic-sub",
                enabled: true,
                billing: { mode: "subscription" },
                useEnvApiKey: false,
                credentials: { accessToken, refreshToken, longLivedToken },
            }));
        });
        const read = spyOn(fs, "readFileSync");
        try {
            const facade = await AIConfig.load();
            expect(facade.listAccounts()).toHaveLength(12);
            expect(read.mock.calls.filter(([path]) => path === vaultAdmin.path())).toHaveLength(1);
            for (let i = 0; i < 10; i++) {
                await AIConfig.load();
            }
            expect(read.mock.calls.filter(([path]) => path === vaultAdmin.path())).toHaveLength(1);
        } finally {
            read.mockRestore();
        }
    });

    it("load() returns a singleton", async () => {
        const a = await AIConfig.load();
        const b = await AIConfig.load();
        expect(a).toBe(b);
    });

    it("invalidate() clears singleton so next load() creates new instance", async () => {
        const a = await AIConfig.load();
        AIConfig.invalidate();
        const b = await AIConfig.load();
        expect(a).not.toBe(b);
    });

    it("getAppDefaults / setAppDefaults round-trips", async () => {
        const config = await AIConfig.load();

        await config.setAppDefaults("test-app", {
            provider: "ollama",
            model: "llama3",
            temperature: 0.7,
        });

        const defaults = config.getAppDefaults("test-app");
        expect(defaults?.provider).toBe("ollama");
        expect(defaults?.model).toBe("llama3");
        expect(defaults?.temperature).toBe(0.7);

        // Clean up
        await config.setAppDefaults("test-app", {
            provider: undefined,
            model: undefined,
            temperature: undefined,
        });
    });

    it("getTask returns config or default for known tasks", async () => {
        const config = await AIConfig.load();
        const task = config.getTask("transcribe");
        expect(task).toBeDefined();
        expect(task.provider).toBeTruthy();
    });

    it("getAccount returns undefined for non-existent account", async () => {
        const config = await AIConfig.load();
        expect(config.getAccount("does-not-exist-xyz")).toBeUndefined();
    });

    it("getAccountsByProvider returns array", async () => {
        const config = await AIConfig.load();
        const accounts = config.getAccountsByProvider("anthropic-sub");
        expect(Array.isArray(accounts)).toBe(true);
    });

    it("isProviderEnabled returns true for unregistered providers", async () => {
        const config = await AIConfig.load();
        expect(config.isProviderEnabled("nonexistent-provider")).toBe(true);
    });

    it("getDefaultAccount falls back to first account when no context default set", async () => {
        const config = await AIConfig.load();
        const account = config.getDefaultAccount("totally-fake-context");
        const allAccounts = config.getAccountsByProvider("anthropic-sub");

        if (allAccounts.length > 0) {
            expect(account).toBeDefined();
        } else {
            expect(account).toBeUndefined();
        }
    });
});

describe("mergeAccountEntry", () => {
    const stored: AIAccountEntry = {
        name: "work-max",
        provider: "anthropic-sub",
        tokens: {
            accessToken: "sk-ant-oat01-old",
            refreshToken: "sk-ant-ort01-old",
            expiresAt: 1000,
            longLivedToken: "sk-ant-oat01-long-lived",
        },
        secondary: { accessToken: "keychain-old", refreshToken: "keychain-refresh-old" },
        label: "max 20x",
        apps: ["claude", "ask"],
    };

    it("keeps the long-lived token when a re-login only supplies the OAuth pair", () => {
        const merged = mergeAccountEntry(stored, {
            name: "work-max",
            provider: "anthropic-sub",
            tokens: { accessToken: "sk-ant-oat01-new", refreshToken: "sk-ant-ort01-new", expiresAt: 2000 },
            apps: ["claude", "ask"],
        });

        expect(merged.tokens.longLivedToken).toBe("sk-ant-oat01-long-lived");
        expect(merged.tokens.accessToken).toBe("sk-ant-oat01-new");
        expect(merged.tokens.expiresAt).toBe(2000);
        expect(merged.secondary?.accessToken).toBe("keychain-old");
        expect(merged.label).toBe("max 20x");
    });

    it("does not let an explicitly undefined label erase the stored one", () => {
        const merged = mergeAccountEntry(stored, {
            name: "work-max",
            provider: "anthropic-sub",
            tokens: { accessToken: "sk-ant-oat01-new" },
            label: undefined,
        });

        expect(merged.label).toBe("max 20x");
    });

    it("replaces wholesale when the provider changes", () => {
        const merged = mergeAccountEntry(stored, {
            name: "work-max",
            provider: "openai-sub",
            tokens: { accessToken: "openai-token" },
        });

        expect(merged.provider).toBe("openai-sub");
        expect(merged.tokens.longLivedToken).toBeUndefined();
        expect(merged.secondary).toBeUndefined();
    });
});
