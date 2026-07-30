import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    isSecureRef,
    secrets,
} from "@genesiscz/utils/security";
import type { BindContext, ProviderPlugin } from "../providers/plugin-types";
import { _resetPluginsForTest, registerPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import {
    AccountInUseError,
    addAccount,
    clearCredentials,
    editAccount,
    removeAccount,
    testAccount,
} from "./account-ops";
import { _clearExternalRefScanners, registerExternalRefScanner } from "./refs";
import { type AiConfigData, CONFIG_VERSION } from "./schema";

const KEY = Buffer.alloc(32, 3);

let home: string;

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

function writeConfig(data: AiConfigData): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
}

function readRawConfig(): AiConfigData {
    return SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
}

function fakePlugin(overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
    return {
        id: "fake",
        kind: "api-key",
        capabilities: new Set(["chat"] as const),
        credential: { fields: ["apiKey"], envKeys: ["FAKE_API_KEY"], required: ["apiKey"] },
        bind: async (ctx: BindContext) => ({
            accountId: ctx.account.id,
            providerId: "fake",
            billed: true,
            language: () => {
                throw new Error("not used in tests");
            },
        }),
        ...overrides,
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-acctops-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    registerPlugin(fakePlugin());
    writeConfig({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _clearExternalRefScanners();
    AiConfigStore.invalidate();
});

describe("addAccount", () => {
    test("mints an id, vaults the secret and never writes it to the config file", async () => {
        const account = await addAccount({ provider: "fake", name: "my key", secrets: { apiKey: "sk-plaintext" } });

        expect(account.id).toBe("acc_my_key");
        expect(isSecureRef(account.credentials.apiKey)).toBe(true);

        const onDisk = readFileSync(configPath(), "utf8");
        expect(onDisk).not.toContain("sk-plaintext");
        expect(onDisk).toContain("ai/acc_my_key/apiKey");

        const vault = await secrets();
        expect(await vault.get("ai/acc_my_key/apiKey")).toBe("sk-plaintext");
    });

    test("carries the endpoint that credential.fields cannot express", async () => {
        const account = await addAccount({ provider: "fake", name: "local", endpoint: "http://127.0.0.1:11434" });

        expect(account.endpoint).toBe("http://127.0.0.1:11434");
        expect(readRawConfig().accounts[0].endpoint).toBe("http://127.0.0.1:11434");
    });

    test("refuses an unknown provider before writing anything", async () => {
        await expect(addAccount({ provider: "nope", name: "x" })).rejects.toThrow('Unknown AI provider "nope"');
        expect(readRawConfig().accounts).toHaveLength(0);
    });

    test("refuses a duplicate name", async () => {
        await addAccount({ provider: "fake", name: "dup" });

        await expect(addAccount({ provider: "fake", name: "dup" })).rejects.toThrow("already exists");
    });

    test("defaults billing from the plugin kind", async () => {
        _resetPluginsForTest();
        registerPlugin(fakePlugin({ id: "sub", kind: "subscription", credential: { fields: [], envKeys: [] } }));
        registerPlugin(fakePlugin({ id: "runtime", kind: "local", credential: { fields: [], envKeys: [] } }));

        expect((await addAccount({ provider: "sub", name: "s" })).billing.mode).toBe("subscription");
        expect((await addAccount({ provider: "runtime", name: "r" })).billing.mode).toBe("free");
    });
});

describe("editAccount", () => {
    test("renaming keeps the id, so existing refs still resolve", async () => {
        const created = await addAccount({ provider: "fake", name: "before" });
        await editAccount("before", { rename: "after", label: "Work", tags: ["a"], useEnvApiKey: ["FAKE_API_KEY"] });

        const store = await AiConfigStore.load();
        const account = store.account("after");

        expect(account?.id).toBe(created.id);
        expect(account?.label).toBe("Work");
        expect(account?.tags).toEqual(["a"]);
        expect(account?.useEnvApiKey).toEqual(["FAKE_API_KEY"]);
    });

    test("disable and re-enable round-trip", async () => {
        await addAccount({ provider: "fake", name: "toggle" });

        expect((await editAccount("toggle", { enabled: false })).enabled).toBe(false);
        expect((await editAccount("toggle", { enabled: true })).enabled).toBe(true);
    });

    test("an unknown account names the listing command", async () => {
        await expect(editAccount("ghost", { enabled: false })).rejects.toThrow("tools ai config account list");
    });
});

describe("removeAccount", () => {
    test("refuses while an in-config default points at it, and names the referrer", async () => {
        const created = await addAccount({ provider: "fake", name: "used" });
        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.defaults.account = { chat: `@account/${created.id}` };
        });

        const failure = await removeAccount("used").catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(AccountInUseError);
        expect((failure as AccountInUseError).referrers[0].path).toBe("defaults.account.chat");
        expect((await AiConfigStore.load()).account("used")).toBeDefined();
    });

    test("an external scanner's reference counts too", async () => {
        const created = await addAccount({ provider: "fake", name: "proxied" });
        registerExternalRefScanner("ai-proxy", async () => [
            { path: "clients[0].account", ref: `@account/${created.id}` },
        ]);

        await expect(removeAccount("proxied")).rejects.toThrow("ai-proxy:clients[0].account");
    });

    test("--force removes a referenced account and takes its vault entries with it", async () => {
        const created = await addAccount({ provider: "fake", name: "used", secrets: { apiKey: "sk-doomed" } });
        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.defaults.account = { chat: `@account/${created.id}` };
        });

        const result = await removeAccount("used", { force: true });

        expect(result.referrers).toHaveLength(1);
        expect(result.secretsDeleted).toEqual(["ai/acc_used/apiKey"]);
        expect(readRawConfig().accounts).toHaveLength(0);
        expect(await (await secrets()).get("ai/acc_used/apiKey")).toBeUndefined();
    });

    test("an unreferenced account needs no force", async () => {
        await addAccount({ provider: "fake", name: "lonely" });

        const result = await removeAccount("lonely");

        expect(result.referrers).toHaveLength(0);
        expect(readRawConfig().accounts).toHaveLength(0);
    });
});

describe("clearCredentials", () => {
    // The bug this pins: `tools claude logout` used to delete fields off a v3
    // token projection and write it back, but `applyV3Tokens` skips absent
    // fields (it cannot distinguish a deliberate deletion from a failed vault
    // read), so the credentials survived while the command printed success.
    test("revokes the named credentials from both the config and the vault", async () => {
        await addAccount({
            provider: "fake",
            name: "sub",
            secrets: { accessToken: "sk-access", refreshToken: "sk-refresh", apiKey: "sk-untouched" },
        });

        const result = await clearCredentials("sub", ["accessToken", "refreshToken"]);
        const vault = await secrets();

        expect(result.secretsDeleted.sort()).toEqual(["ai/acc_sub/accessToken", "ai/acc_sub/refreshToken"]);
        expect(await vault.get("ai/acc_sub/accessToken")).toBeUndefined();
        expect(await vault.get("ai/acc_sub/refreshToken")).toBeUndefined();

        const account = (await AiConfigStore.load()).account("sub");
        expect(account?.credentials.accessToken).toBeUndefined();
        expect(account?.credentials.refreshToken).toBeUndefined();

        // Untouched fields stay, so a partial logout is genuinely partial.
        expect(await vault.get("ai/acc_sub/apiKey")).toBe("sk-untouched");
        expect(account?.credentials.apiKey).toBeDefined();
    });

    test("the account itself survives a credential clear", async () => {
        await addAccount({ provider: "fake", name: "kept", secrets: { accessToken: "sk-a" } });

        await clearCredentials("kept", ["accessToken"]);

        expect((await AiConfigStore.load()).account("kept")).toBeDefined();
    });
});

describe("testAccount", () => {
    test("reports credential source and a successful bind", async () => {
        await addAccount({ provider: "fake", name: "good", secrets: { apiKey: "sk-live" } });

        const result = await testAccount("good");

        expect(result.credential).toEqual({ ok: true, detail: "vault" });
        expect(result.binding.ok).toBe(true);
        expect(result.health).toBeUndefined();
        expect(result.ok).toBe(true);
    });

    test("a missing credential fails without throwing", async () => {
        await addAccount({ provider: "fake", name: "empty" });

        const result = await testAccount("empty");

        expect(result.credential.ok).toBe(false);
        expect(result.credential.detail).toContain("missing apiKey");
        expect(result.ok).toBe(false);
    });

    test("live runs the health probe and folds it into the verdict", async () => {
        _resetPluginsForTest();
        registerPlugin(
            fakePlugin({
                credential: { fields: [], envKeys: [] },
                health: async () => ({ ok: false, detail: "endpoint unreachable" }),
            })
        );
        await addAccount({ provider: "fake", name: "probe" });

        expect((await testAccount("probe")).ok).toBe(true);
        expect((await testAccount("probe", { live: true })).ok).toBe(false);
        expect((await testAccount("probe", { live: true })).health?.detail).toBe("endpoint unreachable");
    });
});
