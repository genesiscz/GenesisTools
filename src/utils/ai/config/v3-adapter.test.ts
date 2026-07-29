import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    isSecureRef,
    secrets,
} from "@genesiscz/utils/security";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "./schema";
import { applyV3Secondary, applyV3Tokens, appsFor, toV3Account } from "./v3-adapter";

const KEY = randomBytes(32);

function fakeKeyring() {
    return [{ id: "keychain" as const, available: async () => true, get: async () => KEY, set: async () => {} }];
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_max",
        name: "martin-max",
        provider: "anthropic-sub",
        enabled: true,
        label: "max 20x",
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

function config(accounts: AccountEntry[], defaults: AiConfigData["defaults"] = {}): AiConfigData {
    return { version: CONFIG_VERSION, accounts, defaults };
}

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-adapter-")));
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
});

describe("toV3Account", () => {
    test("resolves vault refs so legacy callers still see values", async () => {
        const store = await secrets();
        const ref = await store.set("ai/acc_max/accessToken", "sk-ant-oat01-value");
        const entry = account({ credentials: { accessToken: ref, expiresAt: 42 } });

        const v3 = toV3Account(entry, config([entry]));

        expect(v3.tokens.accessToken).toBe("sk-ant-oat01-value");
        expect(v3.tokens.expiresAt).toBe(42);
        expect(v3.label).toBe("max 20x");
    });

    test("omits token fields that are absent rather than emitting empty strings", () => {
        const v3 = toV3Account(account(), config([account()]));

        expect(v3.tokens.accessToken).toBeUndefined();
        expect(v3.tokens.apiKey).toBeUndefined();
        expect(v3.secondary).toBeUndefined();
    });

    test("surfaces the string form of useEnvApiKey as v3's apiKeyEnv", () => {
        const withEnv = account({ useEnvApiKey: "XAI_API_KEY" });
        const withList = account({ useEnvApiKey: ["XAI_API_KEY", "X_AI_API_KEY"] });

        expect(toV3Account(withEnv, config([withEnv])).tokens.apiKeyEnv).toBe("XAI_API_KEY");
        // A list has no v3 equivalent; emitting the first would silently narrow it.
        expect(toV3Account(withList, config([withList])).tokens.apiKeyEnv).toBeUndefined();
    });

    test("keeps authFile a path, never a resolved secret", () => {
        const entry = account({ credentials: { authFile: "~/.grok/auth.json" } });

        expect(toV3Account(entry, config([entry])).tokens.authFile).toBe("~/.grok/auth.json");
    });

    test("derives the apps list from app defaults that reference the account", () => {
        const entry = account();
        const cfg = config([entry], {
            app: { youtube: { chat: { model: "@account/acc_max:opus" } }, other: { chat: { model: "grok-4.5" } } },
        });

        expect(appsFor(cfg, "acc_max")).toEqual(["youtube"]);
        expect(toV3Account(entry, cfg).apps).toEqual(["youtube"]);
    });
});

describe("applyV3Tokens", () => {
    test("routes new secret values into the vault, never into the config object", async () => {
        const entry = account();

        await applyV3Tokens(entry, { apiKey: "sk-literal", expiresAt: 99 });

        expect(isSecureRef(entry.credentials.apiKey)).toBe(true);
        expect(entry.credentials.expiresAt).toBe(99);
        expect(await (await secrets()).get("ai/acc_max/apiKey")).toBe("sk-literal");
    });

    test("apiKeyEnv from a legacy caller becomes useEnvApiKey", async () => {
        const entry = account();

        await applyV3Tokens(entry, { apiKeyEnv: "XAI_API_KEY" });

        expect(entry.useEnvApiKey).toBe("XAI_API_KEY");
    });

    test("secondary logins are vaulted too", async () => {
        const entry = account();

        await applyV3Secondary(entry, { accessToken: "kc-access", refreshToken: "kc-refresh", accountUuid: "5f2c" });

        expect(isSecureRef(entry.credentials.secondary?.accessToken)).toBe(true);
        expect(entry.credentials.secondary?.accountUuid).toBe("5f2c");
        expect(await (await secrets()).get("ai/acc_max/secondary.refreshToken")).toBe("kc-refresh");
    });

    test("round-trip: v4 -> v3 -> v4 preserves the values", async () => {
        const entry = account();
        await applyV3Tokens(entry, { apiKey: "sk-round", accessToken: "sk-ant-round" });

        const v3 = toV3Account(entry, config([entry]));
        expect(v3.tokens.apiKey).toBe("sk-round");
        expect(v3.tokens.accessToken).toBe("sk-ant-round");

        const second = account({ id: "acc_copy" });
        await applyV3Tokens(second, v3.tokens);

        expect(await (await secrets()).get("ai/acc_copy/apiKey")).toBe("sk-round");
    });
});
