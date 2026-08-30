import type { AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { slugifyAccountId } from "./migrations/2026-08-configV4";
import { type AccountRef, accountRef, isAccountRef, refToId } from "./refs";
import { type AccountEntry, type AiConfigData, isTaskName } from "./schema";
import { applyV3Secondary, applyV3Tokens, appsFor, toV3Account } from "./v3-adapter";

/**
 * Present the v4 config as the v3 object the `AIConfig` facade and its callers
 * still read, and push v3-shaped edits back into v4. This is the whole reason
 * the facade can be swapped underneath without touching its 30-odd methods.
 */

export function projectToV3(config: AiConfigData): V3ConfigData {
    const defaultAccounts: Record<string, string> = {};

    for (const [task, ref] of Object.entries(config.defaults.account ?? {})) {
        if (!isAccountRef(ref)) {
            continue;
        }

        const account = config.accounts.find((entry) => entry.id === refToId(ref));
        if (account) {
            defaultAccounts[task] = account.name;
        }
    }

    const apps: V3ConfigData["apps"] = {};

    for (const [app, appDefaults] of Object.entries(config.defaults.app ?? {})) {
        if (!appDefaults) {
            continue;
        }

        const { chat, embed, temperature, maxTokens, streaming } = appDefaults;

        // An app default that names an account is v3's defaultAccounts entry.
        const chatModel = chat?.model;
        const chatAccountRef = chatModel?.split(":")[0];
        if (isAccountRef(chatAccountRef)) {
            const account = config.accounts.find((entry) => entry.id === refToId(chatAccountRef as AccountRef));
            if (account) {
                defaultAccounts[app] = account.name;
            }
        }

        const defaults = {
            ...(chat?.provider ? { provider: chat.provider } : {}),
            ...(chatModel && !chatModel.startsWith("@account/") ? { model: chatModel } : {}),
            ...(embed?.provider ? { embeddingProvider: embed.provider } : {}),
            ...(embed?.model ? { embeddingModel: embed.model } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(streaming !== undefined ? { streaming } : {}),
        };

        if (Object.keys(defaults).length > 0) {
            apps[app] = { defaults };
        }
    }

    const tasks: V3ConfigData["tasks"] = {};
    for (const [task, taskDefault] of Object.entries(config.defaults.task ?? {})) {
        if (taskDefault?.provider) {
            tasks[task] = {
                provider: taskDefault.provider as V3ConfigData["tasks"][string]["provider"],
                ...(taskDefault.model ? { model: taskDefault.model } : {}),
            };
        }
    }

    // v3's providers block was dropped in v4; only an explicit provider-level
    // switch-off projects here. Deriving one from "all accounts happen to be
    // disabled" looked equivalent but promoted account state into a global flag
    // that re-enabling the account never cleared — a one-way trapdoor.
    const providers: V3ConfigData["providers"] = {};
    for (const provider of config.disabledProviders ?? []) {
        providers[provider] = { enabled: false, envVariable: "" };
    }

    return {
        _schemaVersion: 3,
        accounts: config.accounts.map((account) => toV3Account(account, config)),
        defaultAccounts,
        tasks,
        apps,
        providers,
    };
}

/**
 * Fold v3-shaped edits back into the v4 config, in place.
 *
 * Accounts are matched by name (v3 has no ids), so a rename through the legacy
 * facade reads as a delete plus an add — which is exactly what v3 did, and why
 * ids exist in v4.
 */
export async function syncV3IntoStore(config: AiConfigData, v3: V3ConfigData): Promise<void> {
    const taken = new Set(config.accounts.map((account) => account.id));
    const seen = new Set<string>();

    for (const incoming of v3.accounts ?? []) {
        seen.add(incoming.name);
        let account = config.accounts.find((entry) => entry.name === incoming.name);

        if (!account) {
            account = {
                id: slugifyAccountId(incoming.name, taken),
                name: incoming.name,
                provider: incoming.provider,
                enabled: true,
                billing: { mode: "metered" },
                credentials: {},
                useEnvApiKey: false,
            } satisfies AccountEntry;
            config.accounts.push(account);
        }

        account.provider = incoming.provider;

        if (incoming.label !== undefined) {
            account.label = incoming.label;
        }

        if (incoming.subscriptionCreatedAt !== undefined) {
            account.subscriptionCreatedAt = incoming.subscriptionCreatedAt;
        }

        if (incoming.subscriptionPlan !== undefined) {
            account.subscriptionPlan = incoming.subscriptionPlan;
        }

        if (incoming.subscriptionStatus !== undefined) {
            account.subscriptionStatus = incoming.subscriptionStatus;
        }

        if (incoming.subscriptionCheckedAt !== undefined) {
            account.subscriptionCheckedAt = incoming.subscriptionCheckedAt;
        }

        if (incoming.planContradictedAt !== undefined) {
            account.planContradictedAt = incoming.planContradictedAt;
        }

        if (incoming.organizationUuid !== undefined) {
            account.organizationUuid = incoming.organizationUuid;
        }

        if (incoming.accountUuid !== undefined) {
            account.accountUuid = incoming.accountUuid;
        }

        if (incoming.apps !== undefined) {
            account.apps = [...incoming.apps];
        }

        await applyV3Tokens(account, incoming.tokens ?? {});

        if (incoming.secondary) {
            await applyV3Secondary(account, incoming.secondary);
        }
    }

    const removed = config.accounts.filter((account) => !seen.has(account.name));
    if (removed.length > 0) {
        config.accounts = config.accounts.filter((account) => seen.has(account.name));
        logger.debug({ removed: removed.map((account) => account.name) }, "legacy facade removed accounts");
    }

    const idByName = new Map(config.accounts.map((account) => [account.name, account.id]));

    config.defaults.account = {};
    config.defaults.app = { ...(config.defaults.app ?? {}) };

    for (const [context, name] of Object.entries(v3.defaultAccounts ?? {})) {
        const id = idByName.get(name);
        if (!id) {
            continue;
        }

        if (isTaskName(context)) {
            config.defaults.account[context] = accountRef(id);
            continue;
        }

        config.defaults.app[context] = { ...(config.defaults.app[context] ?? {}), chat: { model: accountRef(id) } };
    }

    for (const [task, taskConfig] of Object.entries(v3.tasks ?? {})) {
        if (!taskConfig) {
            continue;
        }

        config.defaults.task = {
            ...(config.defaults.task ?? {}),
            [task]: {
                ...(taskConfig.provider ? { provider: taskConfig.provider } : {}),
                ...(taskConfig.model ? { model: taskConfig.model } : {}),
            },
        };
    }

    for (const [app, appConfig] of Object.entries(v3.apps ?? {})) {
        const defaults = appConfig?.defaults;
        if (!defaults) {
            continue;
        }

        const existing = config.defaults.app[app] ?? {};
        const chat = {
            ...(existing.chat ?? {}),
            ...(defaults.provider ? { provider: defaults.provider } : {}),
            ...(defaults.model ? { model: defaults.model } : {}),
        };

        config.defaults.app[app] = {
            ...existing,
            ...(Object.keys(chat).length > 0 ? { chat } : {}),
            ...(defaults.embeddingProvider || defaults.embeddingModel
                ? {
                      embed: {
                          ...(defaults.embeddingProvider ? { provider: defaults.embeddingProvider } : {}),
                          ...(defaults.embeddingModel ? { model: defaults.embeddingModel } : {}),
                      },
                  }
                : {}),
            ...(defaults.temperature !== undefined ? { temperature: defaults.temperature } : {}),
            ...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
            ...(defaults.streaming !== undefined ? { streaming: defaults.streaming } : {}),
        };
    }

    // Provider-level enablement maps to `disabledProviders` alone. Cascading it
    // onto `account.enabled` had no inverse (nothing ever set accounts back to
    // true), so a provider toggle permanently disabled accounts; the global flag
    // already blocks resolution for every account of the provider.
    const disabled = new Set<string>();
    for (const [provider, providerConfig] of Object.entries(v3.providers ?? {})) {
        if (providerConfig?.enabled === false) {
            disabled.add(provider);
        }
    }

    if (disabled.size > 0) {
        config.disabledProviders = [...disabled].sort();
    } else {
        config.disabledProviders = undefined;
    }
}

export { appsFor };
