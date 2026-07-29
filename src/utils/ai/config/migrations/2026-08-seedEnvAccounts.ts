import type { ConfigMigration } from "@genesiscz/utils/config/migration";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { migrationAllowedHere } from "../migration-guard";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../schema";

/**
 * Providers that resolve API keys from the environment today, with the exact
 * variable names each one uses. Audited 2026-07-29 against every call site; the
 * full inventory with file:line anchors lives in the vault as
 * `Rearchitecture-Baseline/grandfather-env-keys.md`.
 *
 * These accounts exist so that flipping key resolution to account-first cannot
 * silently switch anything off. The values are never copied: `useEnvApiKey`
 * names the variable and it is read live, exactly like v3's `apiKeyEnv`.
 */
export const GRANDFATHERED_ENV_PROVIDERS: ReadonlyArray<{ provider: string; envKeys: readonly string[] }> = [
    { provider: "openai", envKeys: ["OPENAI_API_KEY"] },
    { provider: "groq", envKeys: ["GROQ_API_KEY"] },
    { provider: "openrouter", envKeys: ["OPENROUTER_API_KEY"] },
    { provider: "anthropic", envKeys: ["ANTHROPIC_API_KEY"] },
    // GOOGLE_GENERATIVE_AI_API_KEY is what the bare @ai-sdk/google singleton
    // reads; it is invisible to the env facade, so it must be named here or it
    // silently stops working when the singleton path goes away.
    { provider: "google", envKeys: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
    { provider: "xai", envKeys: ["XAI_API_KEY", "X_AI_API_KEY"] },
    { provider: "jinaai", envKeys: ["JINA_AI_API_KEY"] },
    { provider: "assemblyai", envKeys: ["ASSEMBLYAI_API_KEY"] },
    { provider: "deepgram", envKeys: ["DEEPGRAM_API_KEY"] },
    { provider: "gladia", envKeys: ["GLADIA_API_KEY"] },
    { provider: "huggingface", envKeys: ["HUGGINGFACE_TOKEN", "HF_TOKEN"] },
];

export const GRANDFATHER_TAG = "grandfathered";

export function seedAccountFor(provider: string, envKeys: readonly string[]): AccountEntry {
    return {
        id: `acc_env_${provider.replace(/-/g, "_")}`,
        name: `${provider}-env`,
        provider,
        enabled: true,
        label: "environment key",
        tags: [GRANDFATHER_TAG],
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: [...envKeys],
    };
}

/** Providers with no account at all. An existing account is never overwritten. */
export function missingProviders(config: AiConfigData): Array<{ provider: string; envKeys: readonly string[] }> {
    return GRANDFATHERED_ENV_PROVIDERS.filter(
        ({ provider }) => !config.accounts.some((account) => account.provider === provider)
    );
}

function aiStorage(): Storage {
    return new Storage("ai");
}

export const migrateSeedEnvAccounts: ConfigMigration = {
    id: "2026-08-seedEnvAccounts",
    description: "Create accounts for providers whose keys come from the environment",

    shouldRun: async () => {
        const config = await aiStorage().getConfig<AiConfigData>();
        if (!config || config.version !== CONFIG_VERSION) {
            return false;
        }

        if (!migrationAllowedHere()) {
            return false;
        }

        return missingProviders(config).length > 0;
    },

    run: async () => {
        const storage = aiStorage();

        await storage.withConfigLock(async () => {
            const config = await storage.getConfig<AiConfigData>();
            if (!config || config.version !== CONFIG_VERSION) {
                return;
            }

            const missing = missingProviders(config);
            if (missing.length === 0) {
                return;
            }

            for (const { provider, envKeys } of missing) {
                config.accounts.push(seedAccountFor(provider, envKeys));
            }

            await storage.setConfig(config);
            logger.info(
                { seeded: missing.map((entry) => entry.provider) },
                "seeded accounts for environment-resolved providers"
            );
        });
    },
};
