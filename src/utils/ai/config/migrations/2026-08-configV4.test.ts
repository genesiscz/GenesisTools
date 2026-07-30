import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../AiConfigStore";
import { aiConfigSchema, CONFIG_VERSION } from "../schema";
import { convertConfig, migrateConfigV4, slugifyAccountId } from "./2026-08-configV4";

let home: string;

const V3: V3ConfigData = {
    _schemaVersion: 3,
    accounts: [
        {
            name: "martin-max",
            provider: "anthropic-sub",
            label: "max 20x",
            apps: ["claude", "ask"],
            subscriptionCreatedAt: "2026-03-11",
            tokens: {
                accessToken: "sk-ant-oat01-live",
                refreshToken: "sk-ant-ort01-live",
                expiresAt: 1785312000000,
                refreshExpiresAt: 1793088000000,
                longLivedToken: "sk-ant-oat01-long",
            },
            secondary: { accessToken: "keychain-access", refreshToken: "keychain-refresh", accountUuid: "5f2c" },
        },
        { name: "xai-api", provider: "xai", tokens: { apiKeyEnv: "XAI_API_KEY" } },
        { name: "grok-sub", provider: "grok-sub", tokens: { authFile: "~/.grok/auth.json" } },
        { name: "groq-key", provider: "groq", tokens: { apiKey: "gsk_literal" } },
    ],
    defaultAccounts: { ask: "martin-max", chat: "martin-max", claude: "martin-max" },
    tasks: { transcribe: { provider: "local-hf", model: "whisper-large-v3-turbo" }, embed: { provider: "darwinkit" } },
    apps: {
        youtube: {
            defaults: {
                provider: "grok",
                model: "grok-4.5",
                temperature: 0.3,
                embeddingProvider: "local-hf",
                embeddingModel: "bge-small",
            },
        },
    },
    providers: { groq: { enabled: false, envVariable: "GROQ_API_KEY" } },
};

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-v4mig-"));
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

describe("slugifyAccountId", () => {
    test("derives a schema-valid id and disambiguates collisions", () => {
        const taken = new Set<string>();

        expect(slugifyAccountId("martin-max", taken)).toBe("acc_martin_max");
        expect(slugifyAccountId("Martin.Max", taken)).toBe("acc_martin_max_2");
        expect(slugifyAccountId("martin max", taken)).toBe("acc_martin_max_3");
    });
});

describe("convertConfig", () => {
    const v4 = convertConfig(V3);

    test("produces a schema-valid v4 config", () => {
        expect(() => aiConfigSchema.parse(v4)).not.toThrow();
        expect(v4.version).toBe(CONFIG_VERSION);
    });

    test("preserves account ORDER, because accounts[0] is an implicit default in several call sites", () => {
        expect(v4.accounts.map((a) => a.name)).toEqual(["martin-max", "xai-api", "grok-sub", "groq-key"]);
    });

    test("moves every token into credentials without losing a field", () => {
        const max = v4.accounts[0];

        expect(max.credentials.accessToken).toBe("sk-ant-oat01-live");
        expect(max.credentials.refreshToken).toBe("sk-ant-ort01-live");
        expect(max.credentials.longLivedToken).toBe("sk-ant-oat01-long");
        expect(max.credentials.expiresAt).toBe(1785312000000);
        expect(max.credentials.refreshExpiresAt).toBe(1793088000000);
        expect(max.credentials.secondary?.accountUuid).toBe("5f2c");
        expect(max.label).toBe("max 20x");
        expect(max.subscriptionCreatedAt).toBe("2026-03-11");
    });

    test("apiKeyEnv becomes useEnvApiKey, preserving live-env behavior", () => {
        const xai = v4.accounts.find((a) => a.name === "xai-api");

        expect(xai?.useEnvApiKey).toBe("XAI_API_KEY");
        expect(xai?.credentials.apiKey).toBeUndefined();
    });

    test("authFile stays a reference, never copied into credentials as a value", () => {
        expect(v4.accounts.find((a) => a.name === "grok-sub")?.credentials.authFile).toBe("~/.grok/auth.json");
    });

    test("billing mode is derived from the provider", () => {
        expect(v4.accounts.find((a) => a.name === "martin-max")?.billing.mode).toBe("subscription");
        expect(v4.accounts.find((a) => a.name === "grok-sub")?.billing.mode).toBe("subscription");
        expect(v4.accounts.find((a) => a.name === "xai-api")?.billing.mode).toBe("metered");
    });

    test("a disabled provider disables its accounts and donates its env var", () => {
        const groq = v4.accounts.find((a) => a.name === "groq-key");

        expect(groq?.enabled).toBe(false);
        expect(v4.accounts.find((a) => a.name === "martin-max")?.enabled).toBe(true);
    });

    test("defaultAccounts split into task defaults and app defaults, by ref not name", () => {
        expect(v4.defaults.account?.chat).toBe("@account/acc_martin_max");
        expect(v4.defaults.app?.ask?.chat).toEqual({ model: "@account/acc_martin_max" });
        expect(v4.defaults.app?.claude?.chat).toEqual({ model: "@account/acc_martin_max" });
    });

    test("task configs carry over", () => {
        expect(v4.defaults.task?.transcribe).toEqual({ provider: "local-hf", model: "whisper-large-v3-turbo" });
        expect(v4.defaults.task?.embed).toEqual({ provider: "darwinkit" });
    });

    test("app defaults split provider/model into chat and the embedding pair into embed", () => {
        const youtube = v4.defaults.app?.youtube;

        expect(youtube?.chat).toEqual({ provider: "grok", model: "grok-4.5" });
        expect(youtube?.embed).toEqual({ provider: "local-hf", model: "bge-small" });
        expect(youtube?.temperature).toBe(0.3);
    });

    test("a default pointing at a missing account is dropped, not turned into a broken ref", () => {
        const converted = convertConfig({ ...V3, defaultAccounts: { ask: "ghost" } });

        expect(converted.defaults.account).toBeUndefined();
        expect(converted.defaults.app?.ask).toBeUndefined();
    });

    // The hand-rolled slug skipped NFD normalisation, so an accented letter
    // contributed nothing at all: "José" became "acc_jos".
    test("an accented name transliterates instead of losing the letter", () => {
        expect(slugifyAccountId("José", new Set())).toBe("acc_jose");
        expect(slugifyAccountId("Martin Max", new Set())).toBe("acc_martin_max");
    });

    // "cloud" was AICloudProvider("auto"), never a real provider. Carrying it
    // into v4 named a plugin that does not exist and broke `tools ai summarize`
    // with `No enabled account for provider "cloud"` on every migrated home.
    test('the legacy "cloud" task provider is dropped, keeping any model beside it', () => {
        const converted = convertConfig({
            ...V3,
            tasks: { summarize: { provider: "cloud" }, translate: { provider: "cloud", model: "gpt-4o-mini" } },
        });

        expect(converted.defaults.task?.summarize).toEqual({});
        expect(converted.defaults.task?.translate).toEqual({ model: "gpt-4o-mini" });
    });

    test("every other v3 provider is a plugin id and survives the migration verbatim", () => {
        const converted = convertConfig({
            ...V3,
            tasks: { transcribe: { provider: "deepgram" }, embed: { provider: "local-hf" } },
        });

        expect(converted.defaults.task?.transcribe).toEqual({ provider: "deepgram" });
        expect(converted.defaults.task?.embed).toEqual({ provider: "local-hf" });
    });
});

describe("migrateConfigV4", () => {
    test("runs on a v3 file and leaves a store-loadable v4 config", async () => {
        writeFileSync(configPath(), SafeJSON.stringify(V3, null, 2));

        expect(await migrateConfigV4.shouldRun()).toBe(true);
        await migrateConfigV4.run();

        const onDisk = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
        expect(onDisk.version).toBe(CONFIG_VERSION);
        expect(onDisk._schemaVersion).toBeUndefined();

        const store = await AiConfigStore.load();
        expect(store.account("martin-max")?.id).toBe("acc_martin_max");
        expect(store.accounts().length).toBe(4);
    });

    test("is idempotent: a second run is a no-op", async () => {
        writeFileSync(configPath(), SafeJSON.stringify(V3, null, 2));
        await migrateConfigV4.run();
        const first = readFileSync(configPath(), "utf8");

        expect(await migrateConfigV4.shouldRun()).toBe(false);
        await migrateConfigV4.run();

        expect(readFileSync(configPath(), "utf8")).toBe(first);
    });

    test("does not run when there is no config at all", async () => {
        expect(await migrateConfigV4.shouldRun()).toBe(false);
    });

    /**
     * `version !== 4` alone also matched corrupt files and configs from newer
     * builds; run() then attempted to convert garbage and logged a TypeError on
     * every load. Unrecognisable input is the reader's loud error to raise, and
     * a NEWER config must never be "migrated" backwards.
     */
    test("refuses garbage and newer-version configs instead of attempting conversion", async () => {
        writeFileSync(configPath(), SafeJSON.stringify({ version: 99, accounts: "not-an-array" }, null, 2));
        expect(await migrateConfigV4.shouldRun()).toBe(false);

        writeFileSync(configPath(), SafeJSON.stringify({ _schemaVersion: 3, accounts: "not-an-array" }, null, 2));
        expect(await migrateConfigV4.shouldRun()).toBe(false);

        writeFileSync(configPath(), SafeJSON.stringify({ version: 5, accounts: [] }, null, 2));
        expect(await migrateConfigV4.shouldRun()).toBe(false);

        writeFileSync(configPath(), SafeJSON.stringify({ somethingElse: true }, null, 2));
        expect(await migrateConfigV4.shouldRun()).toBe(false);
    });

    test("credential VALUES survive the migration byte-for-byte", async () => {
        writeFileSync(configPath(), SafeJSON.stringify(V3, null, 2));
        await migrateConfigV4.run();

        const store = await AiConfigStore.load();
        const max = store.account("martin-max");

        expect(max?.credentials.accessToken).toBe("sk-ant-oat01-live");
        expect(store.account("groq-key")?.credentials.apiKey).toBe("gsk_literal");
    });
});
