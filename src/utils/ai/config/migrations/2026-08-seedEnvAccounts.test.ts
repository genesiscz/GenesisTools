import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../AiConfigStore";
import { envKeyNames } from "../selectors";
import { type AccountEntry, aiConfigSchema, type AiConfigData, CONFIG_VERSION } from "../schema";
import {
    GRANDFATHER_TAG,
    GRANDFATHERED_ENV_PROVIDERS,
    migrateSeedEnvAccounts,
    missingProviders,
    seedAccountFor,
} from "./2026-08-seedEnvAccounts";

let home: string;

function account(id: string, name: string, provider: string): AccountEntry {
    return {
        id,
        name,
        provider,
        enabled: true,
        billing: { mode: "metered" },
        credentials: { apiKey: "already-configured" },
        useEnvApiKey: false,
    };
}

function writeConfig(config: AiConfigData): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(config, null, 2));
}

const EMPTY: AiConfigData = { version: CONFIG_VERSION, accounts: [], defaults: {} };

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-seed-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

describe("grandfather list", () => {
    test("covers every provider from the 2026-07-29 env audit", () => {
        expect(GRANDFATHERED_ENV_PROVIDERS.map((entry) => entry.provider).sort()).toEqual([
            "anthropic",
            "assemblyai",
            "deepgram",
            "gladia",
            "google",
            "groq",
            "huggingface",
            "jinaai",
            "openai",
            "openrouter",
            "xai",
        ]);
    });

    test("names the facade-invisible google variable and both xai aliases", () => {
        const google = GRANDFATHERED_ENV_PROVIDERS.find((entry) => entry.provider === "google");
        const xai = GRANDFATHERED_ENV_PROVIDERS.find((entry) => entry.provider === "xai");

        expect(google?.envKeys).toEqual(["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);
        expect(xai?.envKeys).toEqual(["XAI_API_KEY", "X_AI_API_KEY"]);
    });

    test("seeded accounts are schema-valid, tagged, and hold no key material", () => {
        for (const { provider, envKeys } of GRANDFATHERED_ENV_PROVIDERS) {
            const seeded = seedAccountFor(provider, envKeys);

            expect(() => aiConfigSchema.parse({ version: CONFIG_VERSION, accounts: [seeded] })).not.toThrow();
            expect(seeded.tags).toContain(GRANDFATHER_TAG);
            expect(seeded.credentials).toEqual({});
            expect(envKeyNames(seeded, [])).toEqual([...envKeys]);
        }
    });
});

describe("migrateSeedEnvAccounts", () => {
    test("seeds an account for every provider that has none", async () => {
        writeConfig(EMPTY);

        expect(await migrateSeedEnvAccounts.shouldRun()).toBe(true);
        await migrateSeedEnvAccounts.run();

        const store = await AiConfigStore.load();
        expect(store.accounts({ tag: GRANDFATHER_TAG }).length).toBe(GRANDFATHERED_ENV_PROVIDERS.length);
        expect(store.account("acc_env_openai")?.useEnvApiKey).toEqual(["OPENAI_API_KEY"]);
    });

    test("never overwrites or duplicates an existing account for that provider", async () => {
        writeConfig({ ...EMPTY, accounts: [account("acc_mine", "my-openai", "openai")] });
        await migrateSeedEnvAccounts.run();

        const store = await AiConfigStore.load();
        expect(store.accounts({ provider: "openai" }).map((a) => a.id)).toEqual(["acc_mine"]);
        expect(store.account("acc_mine")?.credentials.apiKey).toBe("already-configured");
        expect(store.account("acc_env_openai")).toBeUndefined();
    });

    test("existing accounts keep their position, seeds are appended", async () => {
        writeConfig({ ...EMPTY, accounts: [account("acc_mine", "my-openai", "openai")] });
        await migrateSeedEnvAccounts.run();

        const store = await AiConfigStore.load();
        expect(store.accounts()[0].id).toBe("acc_mine");
    });

    test("is idempotent", async () => {
        writeConfig(EMPTY);
        await migrateSeedEnvAccounts.run();
        const afterFirst = (await AiConfigStore.load()).accounts().length;

        expect(await migrateSeedEnvAccounts.shouldRun()).toBe(false);
        await migrateSeedEnvAccounts.run();

        AiConfigStore.invalidate();
        expect((await AiConfigStore.load()).accounts().length).toBe(afterFirst);
    });

    test("does not run against a v3 config or a missing one", async () => {
        expect(await migrateSeedEnvAccounts.shouldRun()).toBe(false);

        writeConfig({ _schemaVersion: 3, accounts: [] } as unknown as AiConfigData);
        expect(await migrateSeedEnvAccounts.shouldRun()).toBe(false);
    });

    test("missingProviders reports only genuinely absent providers", () => {
        const partial: AiConfigData = { ...EMPTY, accounts: [account("acc_x", "x", "xai")] };

        const missing = missingProviders(partial).map((entry) => entry.provider);
        expect(missing).not.toContain("xai");
        expect(missing).toContain("openai");
    });
});
