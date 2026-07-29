import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "@ask/providers/ProviderManager";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { BindContext, ProviderBinding, ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { LanguageModel } from "ai";

let home: string;

function account(id: string, name: string, provider: string): AccountEntry {
    return {
        id,
        name,
        provider,
        enabled: true,
        billing: { mode: provider.endsWith("-sub") ? "subscription" : "metered" },
        credentials: { apiKey: `key-for-${id}` },
        useEnvApiKey: false,
    };
}

const ACCOUNTS: AccountEntry[] = [
    account("acc_xai", "xai-api", "xai"),
    account("acc_openai", "openai-api", "openai"),
    account("acc_max", "martin-max", "anthropic-sub"),
];

function fakePlugin(id: string): ProviderPlugin {
    return {
        id,
        kind: id.endsWith("-sub") ? "subscription" : "api-key",
        capabilities: new Set(["chat"]),
        credential: { fields: ["apiKey"], envKeys: [], required: ["apiKey"] },
        async bind(ctx: BindContext): Promise<ProviderBinding> {
            return {
                accountId: ctx.account.id,
                providerId: id,
                billed: !id.endsWith("-sub"),
                language: (modelId: string) => ({ modelId }) as unknown as LanguageModel,
            };
        },
    };
}

function writeConfig(): void {
    const config: AiConfigData = { version: CONFIG_VERSION, accounts: ACCOUNTS, defaults: {} };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(config, null, 2));
    AiConfigStore.invalidate();
}

/**
 * Grandfathered env resolution reads these live and by design, and the developer
 * running this suite has real ones exported — scrubbed so the detected set is the
 * config's, not the machine's.
 */
const GRANDFATHERED_VARS = [
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "XAI_API_KEY",
    "X_AI_API_KEY",
    "JINA_AI_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "GLADIA_API_KEY",
    "HUGGINGFACE_TOKEN",
    "HF_TOKEN",
];

let envSnapshot: ReturnType<typeof env.testing.snapshot>;

beforeEach(() => {
    envSnapshot = env.testing.snapshot();
    home = mkdtempSync(join(tmpdir(), "gt-provider-manager-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    for (const name of GRANDFATHERED_VARS) {
        env.testing.unset(name);
    }

    AiConfigStore.invalidate();
    _resetPluginsForTest();

    for (const id of ["xai", "openai", "anthropic-sub"]) {
        registerPlugin(fakePlugin(id));
    }

    // Claim the built-ins are already registered so `registerBuiltInPlugins()`
    // inside detectProviders leaves these fakes in place.
    _resetBuiltInPluginsForTest(true);
    writeConfig();
});

afterEach(() => {
    env.testing.restore(envSnapshot);
    AiConfigStore.invalidate();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(false);
});

describe("ProviderManager.detectProviders", () => {
    test("lists one provider per enabled account, named without the -sub suffix", async () => {
        const detected = await new ProviderManager().detectProviders();

        expect(detected.map((provider) => provider.name).sort()).toEqual(["anthropic", "openai", "xai"]);
        expect(detected.find((provider) => provider.name === "anthropic")?.type).toBe("anthropic-sub");
        expect(detected.find((provider) => provider.name === "anthropic")?.subscription).toBe(true);
        expect(detected.find((provider) => provider.name === "xai")?.subscription).toBe(false);
    });

    /**
     * The regression this guard exists for: a targeted scan only looks at ONE
     * provider, so caching its result as complete left a long-running process
     * (the youtube server) serving a single-provider catalog until restart.
     */
    test("a targeted scan is not cached as a complete scan", async () => {
        const manager = new ProviderManager();

        const targeted = await manager.detectProviders("xai");
        expect(targeted.map((provider) => provider.name)).toEqual(["xai"]);

        const full = await manager.detectProviders();
        expect(full.map((provider) => provider.name).sort()).toEqual(["anthropic", "openai", "xai"]);
        expect(manager.getAvailableProviders()).toHaveLength(3);
    });

    test("a full scan is cached: the second call does not rescan", async () => {
        const manager = new ProviderManager();

        await manager.detectProviders();
        // Removing the config would fail a real rescan; the cached answer stands.
        AiConfigStore.invalidate();
        env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-provider-manager-empty-")));

        expect((await manager.detectProviders()).map((provider) => provider.name).sort()).toEqual([
            "anthropic",
            "openai",
            "xai",
        ]);
    });

    test("a repeated targeted scan for an already-detected provider does not rescan", async () => {
        const manager = new ProviderManager();

        await manager.detectProviders("xai");
        AiConfigStore.invalidate();
        env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-provider-manager-empty-")));

        expect((await manager.detectProviders("xai")).map((provider) => provider.name)).toEqual(["xai"]);
    });

    test("an account whose provider has no plugin is skipped, not fatal", async () => {
        const config: AiConfigData = {
            version: CONFIG_VERSION,
            accounts: [...ACCOUNTS, account("acc_ghost", "ghost", "no-such-provider")],
            defaults: {},
        };
        writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(config, null, 2));
        AiConfigStore.invalidate();

        const detected = await new ProviderManager().detectProviders();

        expect(detected.map((provider) => provider.name).sort()).toEqual(["anthropic", "openai", "xai"]);
    });
});
