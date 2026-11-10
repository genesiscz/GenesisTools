import { byId } from "@genesiscz/utils/ai/catalog";
import { discoverModels } from "@genesiscz/utils/ai/catalog/discover";
import { catalogKeysFor, providerNameFor } from "@genesiscz/utils/ai/catalog/keys";
import { pricingFor } from "@genesiscz/utils/ai/catalog/pricing";
import type { CatalogEntry } from "@genesiscz/utils/ai/catalog/types";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { ResolvedBinding, ResolvedModel } from "@genesiscz/utils/ai/core/types";
import type { ProviderBinding, ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import type { AiSdkProvider, DetectedProvider, ModelInfo, ProviderChoice, ProviderConfig } from "../types";
import { getProviderConfig } from "./compat";
import { toModelInfo } from "./model-info";

/**
 * The bridge from the new provider layer back to `ask`'s `DetectedProvider`.
 *
 * `DetectedProvider` is the pre-plugin vocabulary — an ai-sdk provider object
 * plus a model list — and a dozen call sites in ask, youtube, telegram and
 * claude still speak it. Rather than rewrite all of them in one phase, a
 * `ResolvedBinding` (account + plugin + bound provider + model) is projected
 * into that shape here, in ONE place, so the old surface keeps working while
 * everything behind it is the unified config/plugin/catalog stack.
 */

export { catalogKeysFor, providerNameFor };

/**
 * `ProviderConfig` is required by `DetectedProvider` and is only read for its
 * `description` (pickers) — providers that never had a `PROVIDER_CONFIGS` row
 * (github-copilot, ai-proxy, the local runtimes) get a synthesized one rather
 * than being dropped from the list.
 */
export function providerConfigFor(pluginId: string): ProviderConfig {
    const name = providerNameFor(pluginId);
    const known = getProviderConfig(name);

    if (known) {
        return known;
    }

    return { name, type: pluginId, envKey: "", priority: 99 };
}

/**
 * An `AiSdkProvider` face over a `ProviderBinding`.
 *
 * It exposes `languageModel` only — deliberately NOT `chat`, so
 * `getLanguageModel` routes through the binding instead of second-guessing it.
 * The chat-vs-responses decision for OpenAI-shaped providers already happens
 * inside the plugin, which is the one place that knows which dialect the
 * account's endpoint speaks.
 */
function sdkFace(binding: ProviderBinding): AiSdkProvider {
    return {
        languageModel: (modelId: string) => binding.language(modelId),
        textEmbeddingModel: (modelId: string) => {
            if (!binding.embedding) {
                throw new Error(`${binding.providerId} exposes no embedding model`);
            }

            return binding.embedding(modelId);
        },
        imageModel: (modelId: string) => {
            if (!binding.image) {
                throw new Error(`${binding.providerId} exposes no image model`);
            }

            return binding.image(modelId);
        },
    } as AiSdkProvider;
}

/** Chat entries as `ModelInfo`, priced through the catalog ladder and sorted by name; empty when none chats. */
async function pricedChatModels(entries: CatalogEntry[], name: string): Promise<ModelInfo[]> {
    const chat = entries.filter((entry) => entry.capabilities.has("chat") && !entry.flags?.hidden);
    const models = await Promise.all(
        chat.map(async (entry) => {
            const info = toModelInfo(entry);
            return { ...info, provider: name, pricing: (await pricingFor(name, entry.id)) ?? info.pricing };
        })
    );

    models.sort((a, b) => a.name.localeCompare(b.name));
    return models;
}

/** The chat models the catalog lists for a plugin, priced through the catalog ladder. */
export async function modelsForProvider(pluginId: string): Promise<ModelInfo[]> {
    const name = providerNameFor(pluginId);

    for (const key of catalogKeysFor(pluginId)) {
        const models = await pricedChatModels(await discoverModels(key), name);

        if (models.length > 0) {
            return models;
        }
    }

    return [];
}

/**
 * The chat models a picker offers for one account: the plugin's own live list when it has
 * one (`listModels`), else the catalog's list for the plugin. `bind` never lists models, so
 * this is the one place a picker pays for a live listing.
 */
export async function modelsForAccount(plugin: ProviderPlugin, account: AccountEntry): Promise<ModelInfo[]> {
    if (!plugin.listModels) {
        return modelsForProvider(account.provider);
    }

    const models = await pricedChatModels(await plugin.listModels({ account }), providerNameFor(account.provider));
    return models.length > 0 ? models : modelsForProvider(account.provider);
}

/** A resolved model as `ModelInfo`, whether or not the catalog lists it. */
export async function toModelInfoFor(model: ResolvedModel, providerName: string): Promise<ModelInfo> {
    const entry = "unlisted" in model ? byId(model.id, providerName) : model;

    if (entry) {
        const info = toModelInfo(entry);
        return { ...info, provider: providerName, pricing: (await pricingFor(providerName, entry.id)) ?? info.pricing };
    }

    return {
        id: model.id,
        name: model.id,
        contextWindow: 0,
        capabilities: ["chat"],
        provider: providerName,
        pricing: (await pricingFor(providerName, model.id)) ?? undefined,
    };
}

export interface ToDetectedProviderOptions {
    binding: ProviderBinding;
    pluginId: string;
    /** `id` is the immutable account id: the usage row records it, never the renameable name. */
    account?: { id: string; name: string; label?: string };
    models: ModelInfo[];
    /** How the credential was found ("env (OPENAI_API_KEY)", "vault", …). Never the value. */
    credentialSource?: string;
}

export function toDetectedProvider(options: ToDetectedProviderOptions): DetectedProvider {
    const { binding, pluginId, models } = options;
    const name = providerNameFor(pluginId);

    return {
        name,
        type: pluginId,
        // The old field held the raw API key. Nothing reads it for auth (the
        // binding already carries the credential), and a plaintext key on a
        // widely-passed object is how one leaks into a log line.
        key: options.credentialSource ?? "resolved",
        provider: sdkFace(binding),
        models,
        config: providerConfigFor(pluginId),
        ...(binding.systemPromptPrefix ? { systemPromptPrefix: binding.systemPromptPrefix } : {}),
        subscription: !binding.billed,
        ...(options.account ? { account: options.account } : {}),
    };
}

/** A `ResolvedBinding` as the `{provider, model}` pair every pre-Phase-4 call site takes. */
export async function toProviderChoice(resolved: ResolvedBinding): Promise<ProviderChoice> {
    const pluginId = resolved.plugin.id;
    const name = providerNameFor(pluginId);
    const model = await toModelInfoFor(resolved.model, name);

    return {
        provider: toDetectedProvider({
            binding: resolved.binding,
            pluginId,
            account: {
                id: resolved.account.id,
                name: resolved.account.name,
                ...(resolved.account.label ? { label: resolved.account.label } : {}),
            },
            models: [model],
        }),
        model,
    };
}
