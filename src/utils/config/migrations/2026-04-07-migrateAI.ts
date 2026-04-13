import logger from "@app/logger";
import type {
    AIAccountEntry,
    AIConfigData,
    AIProvider,
    AppConfig,
    ProviderConfig,
    TaskConfig,
} from "@app/utils/config/ai.types";
import type { ConfigMigration } from "@app/utils/config/migration";
import { Storage } from "@app/utils/storage/storage";

const VALID_PROVIDERS = new Set<string>([
    "anthropic",
    "anthropic-sub",
    "openai",
    "openai-sub",
    "google",
    "groq",
    "elevenlabs",
    "huggingface",
]);

// ── Old config shapes (read-only, for deserialization) ──

interface OldAIConfig {
    hfToken?: string;
    transcribe?: { provider: string; model?: string };
    translate?: { provider: string; model?: string };
    summarize?: { provider: string; model?: string };
    classify?: { provider: string; model?: string };
    embed?: { provider: string; model?: string };
    sentiment?: { provider: string; model?: string };
    tts?: { provider: string; model?: string };
}

interface OldAccountConfig {
    accounts: Array<{
        name: string;
        provider: string;
        tokens: Record<string, string | number | undefined>;
        label?: string;
        apps?: string[];
    }>;
    defaultAccount?: string;
}

interface OldAskConfig {
    defaultProvider?: string;
    defaultModel?: string;
    maxTokens?: number;
    temperature?: number;
    streaming?: boolean;
    claude?: {
        accountRef?: string;
        accountLabel?: string;
        accountName?: string;
    };
    envTokens?: {
        enabled: boolean;
        disabledProviders?: string[];
    };
}

interface OldClaudeConfig {
    accounts: Record<
        string,
        {
            accessToken?: string;
            refreshToken?: string;
            expiresAt?: number;
            label?: string;
        }
    >;
    defaultAccount?: string;
}

// ── Default provider registry ──
// Matches envKey from src/ask/providers/providers.ts PROVIDER_CONFIGS

const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
    openai: { enabled: true, envVariable: "OPENAI_API_KEY" },
    anthropic: { enabled: true, envVariable: "ANTHROPIC_API_KEY" },
    google: { enabled: true, envVariable: "GOOGLE_API_KEY" },
    groq: { enabled: true, envVariable: "GROQ_API_KEY" },
    openrouter: { enabled: true, envVariable: "OPENROUTER_API_KEY" },
    xai: { enabled: true, envVariable: "X_AI_API_KEY" },
    jinaai: { enabled: false, envVariable: "JINA_AI_API_KEY" },
    deepseek: { enabled: true, envVariable: "DEEPSEEK_API_KEY" },
};

// ── Default task configs ──
// Matches DEFAULT_CONFIG from src/utils/ai/AIConfig.ts

const DEFAULT_TASKS: Record<string, TaskConfig> = {
    transcribe: { provider: "local-hf" },
    translate: { provider: "local-hf" },
    summarize: { provider: "cloud" },
    classify: { provider: "darwinkit" },
    embed: { provider: "darwinkit" },
    sentiment: { provider: "darwinkit" },
    tts: { provider: "cloud" },
};

const TASK_KEYS = ["transcribe", "translate", "summarize", "classify", "embed", "sentiment", "tts"];

// ── Helpers ──

async function readOldConfig<T extends object>(toolName: string): Promise<T | null> {
    try {
        const storage = new Storage(toolName);
        return await storage.getConfig<T>();
    } catch {
        return null;
    }
}

// ── Migration ──

export const migrateAI: ConfigMigration = {
    id: "2026-04-07-unified-ai-config",
    description: "Consolidate ai, ai-accounts, and ask configs into unified ai/config.json",

    async shouldRun() {
        const storage = new Storage("ai");
        const existing = await storage.getConfig<Record<string, unknown>>();

        if (!existing?._schemaVersion) {
            return true;
        }

        return (existing._schemaVersion as number) < 3;
    },

    async run() {
        const aiStorage = new Storage("ai");

        // 1. Read old configs (all optional)
        const oldAI = await readOldConfig<OldAIConfig>("ai");
        const oldAccounts = await readOldConfig<OldAccountConfig>("ai-accounts");
        const oldAsk = await readOldConfig<OldAskConfig>("ask");
        const oldClaude = await readOldConfig<OldClaudeConfig>("claude");

        // 2. Read existing unified config (may have partial data)
        const existing = (await aiStorage.getConfig<Partial<AIConfigData>>()) ?? {};

        // 3. Build unified config -- never overwrite fields already in target

        // ── Accounts ──
        let accounts: AIAccountEntry[] = [];

        if (existing.accounts && existing.accounts.length > 0) {
            accounts = existing.accounts;
        } else {
            // Import from old ai-accounts config (validate provider strings)
            if (oldAccounts?.accounts && oldAccounts.accounts.length > 0) {
                for (const acc of oldAccounts.accounts) {
                    if (!VALID_PROVIDERS.has(acc.provider)) {
                        logger.warn(
                            `[migration] Skipping account "${acc.name}" with unknown provider "${acc.provider}"`
                        );
                        continue;
                    }

                    accounts.push({ ...acc, provider: acc.provider as AIProvider } as AIAccountEntry);
                }
            }

            // Import claude accounts as anthropic-sub entries
            // (same logic as account-storage.ts migrateFromClaude)
            if (oldClaude?.accounts && Object.keys(oldClaude.accounts).length > 0) {
                const existingNames = new Set(accounts.map((a) => a.name));

                for (const [name, account] of Object.entries(oldClaude.accounts)) {
                    if (existingNames.has(name)) {
                        continue;
                    }

                    accounts.push({
                        name,
                        provider: "anthropic-sub",
                        tokens: {
                            accessToken: account.accessToken,
                            refreshToken: account.refreshToken,
                            expiresAt: account.expiresAt,
                        },
                        label: account.label,
                        apps: ["claude", "ask"],
                    });
                }
            }

            // Migrate hfToken to a huggingface account entry
            if (oldAI?.hfToken) {
                const hasHfAccount = accounts.some((a) => a.provider === "huggingface");

                if (!hasHfAccount) {
                    accounts.push({
                        name: "hf-cloud",
                        provider: "huggingface",
                        tokens: { apiKey: oldAI.hfToken },
                        apps: ["ai"],
                    });
                }
            }
        }

        // Fill empty tokens from claude config (for users who migrated at v2)
        if (oldClaude?.accounts) {
            for (const acc of accounts) {
                if (acc.provider === "anthropic-sub" && !acc.tokens.accessToken) {
                    const claudeAcc = oldClaude.accounts[acc.name];

                    if (claudeAcc?.accessToken) {
                        acc.tokens = {
                            accessToken: claudeAcc.accessToken,
                            refreshToken: claudeAcc.refreshToken,
                            expiresAt: claudeAcc.expiresAt,
                        };
                    }
                }
            }
        }

        // ── Default accounts ──
        let defaultAccounts: Record<string, string> = {};

        if (existing.defaultAccounts && Object.keys(existing.defaultAccounts).length > 0) {
            defaultAccounts = existing.defaultAccounts;
        } else {
            // From old ai-accounts defaultAccount (singular) -> "ask" context
            if (oldAccounts?.defaultAccount) {
                defaultAccounts.ask = oldAccounts.defaultAccount;
            }

            // From old claude defaultAccount -> "claude" context (and "ask" if not set)
            if (oldClaude?.defaultAccount) {
                defaultAccounts.claude = oldClaude.defaultAccount;

                if (!defaultAccounts.ask) {
                    defaultAccounts.ask = oldClaude.defaultAccount;
                }
            }
        }

        // ── Tasks ──
        let tasks: Record<string, TaskConfig> = {};

        if (existing.tasks && Object.keys(existing.tasks).length > 0) {
            tasks = existing.tasks;
        } else if (oldAI) {
            for (const key of TASK_KEYS) {
                const taskEntry = oldAI[key as keyof OldAIConfig];

                if (taskEntry && typeof taskEntry === "object" && "provider" in taskEntry) {
                    tasks[key] = taskEntry as TaskConfig;
                }
            }
        }

        // Fill in any missing tasks with defaults
        for (const [key, defaultTask] of Object.entries(DEFAULT_TASKS)) {
            if (!tasks[key]) {
                tasks[key] = defaultTask;
            }
        }

        // ── Apps ──
        let apps: Record<string, AppConfig> = {};

        if (existing.apps && Object.keys(existing.apps).length > 0) {
            apps = existing.apps;
        } else if (oldAsk) {
            const askDefaults: Record<string, unknown> = {};

            if (oldAsk.defaultProvider) {
                askDefaults.provider = oldAsk.defaultProvider;
            }

            if (oldAsk.defaultModel) {
                askDefaults.model = oldAsk.defaultModel;
            }

            if (oldAsk.temperature !== undefined) {
                askDefaults.temperature = oldAsk.temperature;
            }

            if (oldAsk.maxTokens !== undefined) {
                askDefaults.maxTokens = oldAsk.maxTokens;
            }

            if (oldAsk.streaming !== undefined) {
                askDefaults.streaming = oldAsk.streaming;
            }

            if (Object.keys(askDefaults).length > 0) {
                apps.ask = { defaults: askDefaults };
            }
        }

        // ── Providers ──
        let providers: Record<string, ProviderConfig> = {};

        if (existing.providers && Object.keys(existing.providers).length > 0) {
            providers = existing.providers;
        } else {
            // Start with defaults
            providers = { ...DEFAULT_PROVIDERS };

            // Apply disabled providers from old ask config
            if (oldAsk?.envTokens?.disabledProviders) {
                for (const name of oldAsk.envTokens.disabledProviders) {
                    if (providers[name]) {
                        providers[name] = { ...providers[name], enabled: false };
                    }
                }
            }

            // If envTokens master switch was off, disable all
            if (oldAsk?.envTokens && !oldAsk.envTokens.enabled) {
                for (const name of Object.keys(providers)) {
                    providers[name] = { ...providers[name], enabled: false };
                }
            }
        }

        // 4. Stamp and write atomically under config lock
        const unified: AIConfigData = {
            _schemaVersion: 3,
            accounts,
            defaultAccounts,
            tasks,
            apps,
            providers,
        };

        await aiStorage.withConfigLock(async () => {
            await aiStorage.setConfig(unified);
        });

        // 5. Clean up migrated fields from old configs so they don't confuse users
        try {
            const claudeStorage = new Storage("claude");
            await claudeStorage.atomicConfigUpdate((data: Record<string, unknown>) => {
                delete data.accounts;
                delete data.defaultAccount;
            });
        } catch {
            // Old config may not exist — that's fine
        }

        logger.info(
            `Unified AI config written: ${accounts.length} account(s), ` +
                `${Object.keys(tasks).length} task(s), ` +
                `${Object.keys(providers).length} provider(s)`
        );
    },
};
