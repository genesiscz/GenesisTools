import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    isSecureRef,
    resolveSecret,
    secrets,
} from "@genesiscz/utils/security";
import { AiConfigStore } from "../AiConfigStore";
import { CONFIG_VERSION } from "../schema";
import { migrateConfigV4 } from "./2026-08-configV4";
import { migrateSecretsToVault } from "./2026-08-secretsToVault";
import { GRANDFATHER_TAG, migrateSeedEnvAccounts } from "./2026-08-seedEnvAccounts";

/**
 * The rehearsal the campaign requires before the live migration: run the whole
 * chain, in order, over a realistic v3 config and assert the end state rather
 * than each step in isolation.
 */

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

const REALISTIC_V3: V3ConfigData = {
    _schemaVersion: 3,
    accounts: [
        {
            name: "martin-max",
            provider: "anthropic-sub",
            label: "max 20x",
            apps: ["claude", "ask"],
            tokens: {
                accessToken: "sk-ant-oat01-real",
                refreshToken: "sk-ant-ort01-real",
                expiresAt: 1785312000000,
                longLivedToken: "sk-ant-oat01-longlived",
            },
            secondary: { accessToken: "keychain-access", refreshToken: "keychain-refresh", accountUuid: "5f2c" },
        },
        { name: "grok-cli", provider: "grok-sub", tokens: { authFile: "~/.grok/auth.json" } },
        { name: "xai-key", provider: "xai", tokens: { apiKeyEnv: "XAI_API_KEY" } },
        { name: "hf", provider: "huggingface", tokens: { apiKey: "hf_realistic" } },
    ],
    defaultAccounts: { ask: "martin-max", claude: "martin-max" },
    tasks: { transcribe: { provider: "local-hf", model: "whisper-large-v3-turbo" } },
    apps: { youtube: { defaults: { provider: "grok", model: "grok-4.5" } } },
    providers: {},
};

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

async function runChain(): Promise<void> {
    for (const migration of [migrateConfigV4, migrateSecretsToVault, migrateSeedEnvAccounts]) {
        if (await migration.shouldRun()) {
            await migration.run();
        }
    }
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-chain-"));
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(REALISTIC_V3, null, 2));
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

describe("migration chain v3 -> v4 -> vault -> seed", () => {
    test("ends with a loadable v4 config, no plaintext, and every credential still resolvable", async () => {
        await runChain();

        const store = await AiConfigStore.load();
        const max = store.account("martin-max");

        expect(store.data().version).toBe(CONFIG_VERSION);
        expect(isSecureRef(max?.credentials.accessToken)).toBe(true);
        expect(await resolveSecret(max?.credentials.accessToken)).toBe("sk-ant-oat01-real");
        expect(await resolveSecret(max?.credentials.secondary?.refreshToken)).toBe("keychain-refresh");
        expect(await resolveSecret(store.account("hf")?.credentials.apiKey)).toBe("hf_realistic");

        const onDisk = readFileSync(configPath(), "utf8");
        for (const secret of ["sk-ant-oat01-real", "sk-ant-ort01-real", "sk-ant-oat01-longlived", "hf_realistic"]) {
            expect(onDisk).not.toContain(secret);
        }
    });

    test("keeps every original account, in order, ahead of the seeded ones", async () => {
        await runChain();
        const store = await AiConfigStore.load();

        expect(
            store
                .accounts()
                .slice(0, 4)
                .map((a) => a.name)
        ).toEqual(["martin-max", "grok-cli", "xai-key", "hf"]);
        expect(store.accounts({ tag: GRANDFATHER_TAG }).every((a) => a.credentials.apiKey === undefined)).toBe(true);
    });

    test("an env-referencing account is NOT given a duplicate seed account", async () => {
        await runChain();
        const store = await AiConfigStore.load();

        expect(store.accounts({ provider: "xai" }).map((a) => a.name)).toEqual(["xai-key"]);
        expect(store.account("xai-key")?.useEnvApiKey).toBe("XAI_API_KEY");
        expect(store.accounts({ provider: "huggingface" }).map((a) => a.name)).toEqual(["hf"]);
    });

    test("references survive: defaults point at ids that resolve", async () => {
        await runChain();
        const store = await AiConfigStore.load();

        const ref = store.data().defaults.app?.ask?.chat?.model;
        expect(ref).toBe("@account/acc_martin_max");
        expect((await store.referrers("acc_martin_max")).length).toBeGreaterThan(0);
    });

    test("the whole chain is idempotent and leaves the 0600 backup in place", async () => {
        await runChain();
        const afterFirst = readFileSync(configPath(), "utf8");
        const vaultEntries = (await (await secrets()).list()).length;

        await runChain();

        AiConfigStore.invalidate();
        expect(readFileSync(configPath(), "utf8")).toBe(afterFirst);
        expect((await (await secrets()).list()).length).toBe(vaultEntries);

        const backup = join(home, ".genesis-tools", "ai", "config.v3.plaintext.bak.json");
        expect(statSync(backup).mode & 0o777).toBe(0o600);
        expect(readFileSync(backup, "utf8")).toContain("sk-ant-oat01-real");
    });

    test("an authFile reference is never turned into a vault entry", async () => {
        await runChain();

        const store = await AiConfigStore.load();
        expect(store.account("grok-cli")?.credentials.authFile).toBe("~/.grok/auth.json");
        expect(await (await secrets()).has("ai/acc_grok_cli/authFile")).toBe(false);
    });
});
