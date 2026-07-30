import type { AIAccountEntry, AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import type { ConfigMigration } from "@genesiscz/utils/config/migration";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { migrationAllowedHere } from "../migration-guard";
import { accountRef } from "../refs";
import {
    type AccountEntry,
    type AiConfigData,
    type AppDefault,
    CONFIG_VERSION,
    isTaskName,
    type TaskDefault,
    type UseEnvApiKey,
} from "../schema";

/** Providers billed by a subscription rather than per token. */
const SUBSCRIPTION_PROVIDERS = new Set(["anthropic-sub", "openai-sub", "grok-sub", "github-copilot"]);

export function slugifyAccountId(name: string, taken: Set<string>): string {
    const base =
        `acc_${name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")}` || "acc_account";
    let candidate = base;
    let suffix = 2;

    while (taken.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
    }

    taken.add(candidate);
    return candidate;
}

function billingFor(provider: string): AccountEntry["billing"] {
    return SUBSCRIPTION_PROVIDERS.has(provider) ? { mode: "subscription" } : { mode: "metered" };
}

/**
 * v3 stored the env-var NAME in `tokens.apiKeyEnv` and read it live. v4 keeps
 * exactly that behavior under a clearer name, so an account that resolved its
 * key from the environment yesterday still does today.
 */
function envApiKeySettingFor(account: AIAccountEntry, providerDisabledEnv: string | undefined): UseEnvApiKey {
    if (account.tokens.apiKeyEnv) {
        return account.tokens.apiKeyEnv;
    }

    if (providerDisabledEnv) {
        return providerDisabledEnv;
    }

    return false;
}

export function convertAccount(account: AIAccountEntry, id: string, envVariable?: string): AccountEntry {
    const { apiKey, accessToken, refreshToken, longLivedToken, authFile, ...rest } = account.tokens;

    const entry: AccountEntry = {
        id,
        name: account.name,
        provider: account.provider,
        enabled: true,
        billing: billingFor(account.provider),
        credentials: {
            ...(apiKey ? { apiKey } : {}),
            ...(accessToken ? { accessToken } : {}),
            ...(refreshToken ? { refreshToken } : {}),
            ...(longLivedToken ? { longLivedToken } : {}),
            ...(authFile ? { authFile } : {}),
            ...(rest.expiresAt !== undefined ? { expiresAt: rest.expiresAt } : {}),
            ...(rest.refreshExpiresAt !== undefined ? { refreshExpiresAt: rest.refreshExpiresAt } : {}),
            ...(rest.longLivedTokenExpiresAt !== undefined
                ? { longLivedTokenExpiresAt: rest.longLivedTokenExpiresAt }
                : {}),
            ...(account.secondary ? { secondary: account.secondary } : {}),
        },
        useEnvApiKey: envApiKeySettingFor(account, envVariable),
    };

    if (account.label) {
        entry.label = account.label;
    }

    if (account.apps && account.apps.length > 0) {
        entry.apps = [...account.apps];
    }

    if (account.subscriptionCreatedAt) {
        entry.subscriptionCreatedAt = account.subscriptionCreatedAt;
    }

    return entry;
}

/**
 * v3 `apps.<name>.defaults` carried provider/model plus generation settings.
 * Provider and model become the app's chat default; the embedding pair becomes
 * its embed default; the rest stay as top-level knobs.
 */
function convertAppDefaults(defaults: Record<string, unknown> | undefined): AppDefault | undefined {
    if (!defaults) {
        return undefined;
    }

    const { provider, model, embeddingProvider, embeddingModel, temperature, maxTokens, streaming } = defaults as {
        provider?: string;
        model?: string;
        embeddingProvider?: string;
        embeddingModel?: string;
        temperature?: number;
        maxTokens?: number;
        streaming?: boolean;
    };

    const converted: AppDefault = {};

    if (provider || model) {
        converted.chat = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) } as TaskDefault;
    }

    if (embeddingProvider || embeddingModel) {
        converted.embed = {
            ...(embeddingProvider ? { provider: embeddingProvider } : {}),
            ...(embeddingModel ? { model: embeddingModel } : {}),
        } as TaskDefault;
    }

    if (temperature !== undefined) {
        converted.temperature = temperature;
    }

    if (maxTokens !== undefined) {
        converted.maxTokens = maxTokens;
    }

    if (streaming !== undefined) {
        converted.streaming = streaming;
    }

    return Object.keys(converted).length > 0 ? converted : undefined;
}

export function convertConfig(v3: V3ConfigData): AiConfigData {
    const taken = new Set<string>();
    const idByName = new Map<string, string>();

    // Provider-level `enabled: false` becomes per-account; `envVariable` feeds useEnvApiKey.
    const disabledProviders = new Set<string>();
    const envVarByProvider = new Map<string, string>();
    for (const [provider, config] of Object.entries(v3.providers ?? {})) {
        if (config?.enabled === false) {
            disabledProviders.add(provider);
        }

        if (config?.envVariable) {
            envVarByProvider.set(provider, config.envVariable);
        }
    }

    const accounts: AccountEntry[] = (v3.accounts ?? []).map((account) => {
        const id = slugifyAccountId(account.name, taken);
        idByName.set(account.name, id);

        const converted = convertAccount(account, id, envVarByProvider.get(account.provider));
        if (disabledProviders.has(account.provider)) {
            converted.enabled = false;
        }

        return converted;
    });

    const defaults: AiConfigData["defaults"] = {};

    // v3 defaultAccounts is context -> account NAME. Known task names land in
    // defaults.account; everything else was an app context.
    for (const [context, name] of Object.entries(v3.defaultAccounts ?? {})) {
        const id = idByName.get(name);
        if (!id) {
            logger.warn({ context, name }, "v4 migration: default account references an unknown account, dropping");
            continue;
        }

        if (isTaskName(context)) {
            defaults.account = { ...(defaults.account ?? {}), [context]: accountRef(id) };
            continue;
        }

        const app = defaults.app?.[context] ?? {};
        defaults.app = { ...(defaults.app ?? {}), [context]: { ...app, chat: { model: accountRef(id) } } };
    }

    for (const [task, config] of Object.entries(v3.tasks ?? {})) {
        if (!config) {
            continue;
        }

        defaults.task = {
            ...(defaults.task ?? {}),
            [task]: {
                ...(config.provider ? { provider: config.provider } : {}),
                ...(config.model ? { model: config.model } : {}),
            },
        };
    }

    for (const [app, config] of Object.entries(v3.apps ?? {})) {
        const converted = convertAppDefaults(config?.defaults as Record<string, unknown> | undefined);
        if (!converted) {
            continue;
        }

        defaults.app = { ...(defaults.app ?? {}), [app]: { ...(defaults.app?.[app] ?? {}), ...converted } };
    }

    const disabled = [...disabledProviders].sort();

    return {
        version: CONFIG_VERSION,
        accounts,
        defaults,
        ...(disabled.length > 0 ? { disabledProviders: disabled } : {}),
    };
}

/**
 * Resolved per call, never at module scope: `Storage` captures the root from
 * GENESIS_TOOLS_HOME when it is constructed, so a module-level instance would
 * bind whatever the environment held at import time.
 */
function aiStorage(): Storage {
    return new Storage("ai");
}

export const migrateConfigV4: ConfigMigration = {
    id: "2026-08-configV4",
    description: "Convert the AI config to v4: account ids, credentials block, account refs",

    shouldRun: async () => {
        const raw = await aiStorage().getConfig<{ version?: number; _schemaVersion?: number; accounts?: unknown }>();
        if (!raw || Object.keys(raw).length === 0) {
            return false;
        }

        if (!migrationAllowedHere()) {
            return false;
        }

        // Only a recognisable OLDER config migrates. `version !== 4` alone also
        // matched corrupt files and configs from newer builds, so run() would
        // attempt to convert garbage and log a TypeError on every load before
        // the reader's own loud schema error. Unrecognisable input is the
        // reader's problem, not a migration's.
        const version = raw.version ?? raw._schemaVersion;
        if (typeof version !== "number" || version >= CONFIG_VERSION) {
            return false;
        }

        return raw.accounts === undefined || Array.isArray(raw.accounts);
    },

    run: async () => {
        const storage = aiStorage();

        await storage.withConfigLock(async () => {
            const raw = await storage.getConfig<V3ConfigData & { version?: number }>();
            if (
                !raw ||
                raw.version === CONFIG_VERSION ||
                (raw.accounts !== undefined && !Array.isArray(raw.accounts))
            ) {
                return;
            }

            const converted = convertConfig(raw);
            await storage.setConfig(converted);
            logger.info(
                { accounts: converted.accounts.length, from: raw._schemaVersion ?? "unknown" },
                "migrated AI config to v4"
            );
        });
    },
};
