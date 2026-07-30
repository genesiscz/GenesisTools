import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    isSecureRef,
} from "@genesiscz/utils/security";
import { AiConfigStore } from "./AiConfigStore";
import { ensureAiConfigMigrated } from "./migrate";
import { type AiConfigData, CONFIG_VERSION } from "./schema";

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

const WITH_PLAINTEXT: AiConfigData = {
    version: CONFIG_VERSION,
    accounts: [
        {
            id: "acc_max",
            name: "martin-max",
            provider: "anthropic-sub",
            enabled: true,
            billing: { mode: "subscription" },
            credentials: { accessToken: "sk-ant-oat01-live" },
            useEnvApiKey: false,
        },
    ],
    defaults: {},
};

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

function vaultPath(): string {
    return join(home, ".genesis-tools", "security", "vault.json");
}

function readConfig(): AiConfigData {
    return SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-migrate-chain-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(WITH_PLAINTEXT, null, 2));
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

describe("ensureAiConfigMigrated", () => {
    /**
     * `runMigrations` logs a failing migration, stops the chain and resolves
     * normally, so the caller cannot tell success from failure by its return
     * value. Latching the process guard regardless left the config holding
     * plaintext credentials while every later load in the same process skipped
     * the retry, which is the state the vault migration exists to end.
     */
    test("a failed migration does not latch the process guard", async () => {
        mkdirSync(join(home, ".genesis-tools", "security"), { recursive: true });
        writeFileSync(vaultPath(), "{ this is not a vault");

        await ensureAiConfigMigrated();

        // The chain stopped: the credential is still plaintext on disk.
        expect(readConfig().accounts[0].credentials.accessToken).toBe("sk-ant-oat01-live");

        // Clear the fault. A guard that had latched would skip this entirely.
        rmSync(vaultPath());
        _resetSecretsForTest();

        await ensureAiConfigMigrated();

        expect(isSecureRef(readConfig().accounts[0].credentials.accessToken)).toBe(true);
    });

    test("a clean chain latches, so a second call does no work", async () => {
        await ensureAiConfigMigrated();
        expect(isSecureRef(readConfig().accounts[0].credentials.accessToken)).toBe(true);

        const after = readFileSync(configPath(), "utf8");
        await ensureAiConfigMigrated();

        expect(readFileSync(configPath(), "utf8")).toBe(after);
    });
});
