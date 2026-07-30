import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { AiConfigStore } from "../AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../schema";
import { migrateSecretsToVault } from "./2026-08-secretsToVault";

let home: string;
const KEY = randomBytes(32);

function fakeKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => KEY,
            getSync: () => KEY,
            set: async () => {},
        },
    ];
}

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const V4_WITH_PLAINTEXT: AiConfigData = {
    version: CONFIG_VERSION,
    accounts: [
        account("acc_max", "martin-max", {
            credentials: {
                accessToken: "sk-ant-oat01-live",
                refreshToken: "sk-ant-ort01-live",
                longLivedToken: "sk-ant-oat01-long",
                expiresAt: 1785312000000,
                secondary: { accessToken: "keychain-access", refreshToken: "keychain-refresh", accountUuid: "5f2c" },
            },
        }),
        account("acc_xai", "xai-api", {
            provider: "xai",
            billing: { mode: "metered" },
            useEnvApiKey: "XAI_API_KEY",
            credentials: {},
        }),
        account("acc_grok", "grok-sub", {
            provider: "grok-sub",
            credentials: { authFile: "~/.grok/auth.json" },
        }),
    ],
    defaults: {},
};

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

function backupFile(): string {
    return join(home, ".genesis-tools", "ai", "config.v3.plaintext.bak.json");
}

function writeConfig(config: AiConfigData): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(config, null, 2));
}

function readConfig(): AiConfigData {
    return SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-vaultmig-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    AiConfigStore.invalidate();
});

describe("migrateSecretsToVault", () => {
    test("runs only on a v4 config that still holds plaintext", async () => {
        expect(await migrateSecretsToVault.shouldRun()).toBe(false);

        writeConfig(V4_WITH_PLAINTEXT);
        expect(await migrateSecretsToVault.shouldRun()).toBe(true);

        await migrateSecretsToVault.run();
        expect(await migrateSecretsToVault.shouldRun()).toBe(false);
    });

    test("replaces every secret with a SecureRef and leaves no token text in the config", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();

        const config = readConfig();
        const max = config.accounts[0];

        expect(isSecureRef(max.credentials.accessToken)).toBe(true);
        expect(isSecureRef(max.credentials.refreshToken)).toBe(true);
        expect(isSecureRef(max.credentials.longLivedToken)).toBe(true);
        expect(isSecureRef(max.credentials.secondary?.accessToken)).toBe(true);
        expect(isSecureRef(max.credentials.secondary?.refreshToken)).toBe(true);

        const text = readFileSync(configPath(), "utf8");
        for (const secret of ["sk-ant-oat01-live", "sk-ant-ort01-live", "sk-ant-oat01-long", "keychain-access"]) {
            expect(text).not.toContain(secret);
        }
    });

    test("the vault holds the exact original values", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();

        const store = await secrets();
        expect(await store.get("ai/acc_max/accessToken")).toBe("sk-ant-oat01-live");
        expect(await store.get("ai/acc_max/longLivedToken")).toBe("sk-ant-oat01-long");
        expect(await store.get("ai/acc_max/secondary.refreshToken")).toBe("keychain-refresh");
    });

    test("non-secret fields are untouched", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();

        const config = readConfig();
        expect(config.accounts[0].credentials.expiresAt).toBe(1785312000000);
        expect(config.accounts[0].credentials.secondary?.accountUuid).toBe("5f2c");
        expect(config.accounts[2].credentials.authFile).toBe("~/.grok/auth.json");
        expect(config.accounts[1].useEnvApiKey).toBe("XAI_API_KEY");
    });

    test("writes a 0600 plaintext backup and tightens the config itself", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();

        expect(readFileSync(backupFile(), "utf8")).toContain("sk-ant-oat01-live");
        expect(statSync(backupFile()).mode & 0o777).toBe(0o600);
        expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    });

    test("a second run is a no-op and does not overwrite the backup", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();
        const backupAfterFirst = readFileSync(backupFile(), "utf8");
        const configAfterFirst = readFileSync(configPath(), "utf8");

        await migrateSecretsToVault.run();

        expect(readFileSync(backupFile(), "utf8")).toBe(backupAfterFirst);
        expect(readFileSync(configPath(), "utf8")).toBe(configAfterFirst);
    });

    /**
     * A credential added after the first migration makes `shouldRun()` true
     * again. The first backup predates it, and the config on disk no longer
     * holds run one's secrets in plaintext, so neither file on its own is the
     * fallback the warning promises. Run two therefore writes its own copy and
     * leaves run one's alone.
     */
    test("a later run backs up the plaintext it is about to move", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();
        const firstBackup = readFileSync(backupFile(), "utf8");

        const config = readConfig();
        config.accounts[1].credentials.apiKey = "xai-added-after-the-first-run";
        writeConfig(config);

        expect(await migrateSecretsToVault.shouldRun()).toBe(true);
        await migrateSecretsToVault.run();

        expect(readFileSync(backupFile(), "utf8")).toBe(firstBackup);
        expect(firstBackup).not.toContain("xai-added-after-the-first-run");

        const second = join(home, ".genesis-tools", "ai", "config.v3.plaintext.bak.2.json");
        expect(readFileSync(second, "utf8")).toContain("xai-added-after-the-first-run");
        expect(statSync(second).mode & 0o777).toBe(0o600);

        expect(isSecureRef(readConfig().accounts[1].credentials.apiKey)).toBe(true);
        expect(await (await secrets()).get("ai/acc_xai/apiKey")).toBe("xai-added-after-the-first-run");
    });

    test("the migrated config still loads through the store, refs intact", async () => {
        writeConfig(V4_WITH_PLAINTEXT);
        await migrateSecretsToVault.run();

        const store = await AiConfigStore.load();
        const max = store.account("acc_max");

        expect(max?.credentials.accessToken).toEqual({ type: "secure", path: "ai/acc_max/accessToken" });
        expect(store.accounts().length).toBe(3);
    });

    test("an account with nothing to move is left alone", async () => {
        writeConfig({ ...V4_WITH_PLAINTEXT, accounts: [V4_WITH_PLAINTEXT.accounts[2]] });

        expect(await migrateSecretsToVault.shouldRun()).toBe(false);
    });
});
