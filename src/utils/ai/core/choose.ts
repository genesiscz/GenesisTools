import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli/executor";
import { logger } from "@genesiscz/utils/logger";
import { searchSelect, searchSelectCancelSymbol } from "@genesiscz/utils/prompts/clack";
import pc from "picocolors";
import { byProvider, type CatalogEntry, catalogKeysFor, providerNameFor } from "../catalog";
import { discoverModels } from "../catalog/discover";
import { AiConfigStore } from "../config/AiConfigStore";
import { ephemeralEnvAccounts } from "../config/migrations/2026-08-seedEnvAccounts";
import type { AccountEntry } from "../config/schema";
import { describeCredential } from "../providers/credentials";
import { registerBuiltInPlugins } from "../providers/plugins";
import { tryProviderPlugin } from "../providers/registry";
import type { ModelRef } from "./model-ref";
import { ModelResolutionError, resolveModel } from "./resolve";
import type { ResolvedBinding, ResolveOptions } from "./types";

/**
 * The one function a CLI calls to end up with a bound model.
 *
 * Every surface used to grow its own version of this: `ask` had
 * `modelSelector.selectModelByName`, youtube had `resolveProviderChoice`, the
 * claude summarizer had a third copy. They disagreed about small things that
 * cost money — which account a bare provider name picks, whether an explicit
 * `--model` may be completed from a configured spec — so the decision lives here
 * once and everything else is a wrapper.
 */

export interface ChooseProviderModelOptions {
    /** May prompt. A non-TTY caller passing true still gets the non-interactive path. */
    interactive?: boolean;
    task?: ResolveOptions["task"];
    /** Tool name, for `defaults.app.<app>.<task>`. */
    app?: string;
    /** A ModelRef (`opus`, `anthropic/claude-opus-4-5`, `@account/acc_x:opus`). */
    modelRef?: ModelRef;
    /** Provider half, when a CLI takes `--provider` and `--model` separately. */
    provider?: string;
    /** Model half, when a CLI takes `--provider` and `--model` separately. */
    model?: string;
    /**
     * A CONFIGURED spec (`"provider"` or `"provider/model"`), consulted only when
     * the caller named nothing explicitly. Never blended with an explicit choice:
     * silently completing "I asked for opus" with a configured "groq/llama" is how
     * a user ends up billed by a provider they did not name.
     */
    fallbackSpec?: string | null;
    store?: ResolveOptions["store"];
}

/**
 * Splits a `"provider"` / `"provider/model"` config spec. The split is on the
 * FIRST slash so model ids that themselves contain slashes survive.
 *
 * Moved here from `src/youtube/lib/provider-choice.ts`; that file re-exports it
 * for the youtube config code that reads specs without resolving them.
 */
export function parseProviderSpec(spec: string | null | undefined): { provider?: string; model?: string } {
    if (!spec) {
        return {};
    }

    const idx = spec.indexOf("/");
    if (idx === -1) {
        return { provider: spec };
    }

    return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
}

/** The chat models the catalog knows for a provider, curated plus discovered. */
export async function chatModelsFor(providerId: string): Promise<CatalogEntry[]> {
    for (const key of catalogKeysFor(providerId)) {
        const entries = (await discoverModels(key)).filter(
            (entry) => entry.capabilities.has("chat") && !entry.flags?.hidden
        );

        if (entries.length > 0) {
            return entries;
        }
    }

    return [];
}

/** The same list without a network call — the synchronous curated slice only. */
function staticChatModelsFor(providerId: string): CatalogEntry[] {
    for (const key of catalogKeysFor(providerId)) {
        const entries = byProvider(key).filter((entry) => entry.capabilities.has("chat") && !entry.flags?.hidden);

        if (entries.length > 0) {
            return entries;
        }
    }

    return [];
}

function refFor(provider: string | undefined, model: string | undefined): ModelRef | undefined {
    if (provider && model) {
        return `${provider}/${model}`;
    }

    if (model) {
        return model;
    }

    if (!provider) {
        return undefined;
    }

    const first = staticChatModelsFor(provider)[0];

    if (!first) {
        throw new ModelResolutionError(
            `Provider "${provider}" was named without a model and the catalog lists no chat model for it. ` +
                `Name one explicitly, e.g. ${provider}/<model>.`
        );
    }

    return `${provider}/${first.id}`;
}

/** Accounts a picker may offer: enabled ones, plus the grandfathered env entries. */
export async function choosableAccounts(store?: ResolveOptions["store"]): Promise<AccountEntry[]> {
    const loaded = store ?? (await AiConfigStore.load());
    return [...loaded.accounts({ enabled: true }), ...ephemeralEnvAccounts(loaded.data())];
}

export interface ChoosableTarget {
    accountId: string;
    accountName: string;
    accountLabel?: string;
    /** Plugin id, e.g. `anthropic-sub`. */
    providerId: string;
    /** Display/catalog name, e.g. `anthropic`. */
    provider: string;
    modelId: string;
    modelName: string;
    subscription: boolean;
}

/**
 * Every (account, model) pair a caller could pick, WITHOUT binding anything.
 *
 * Credentials are only DESCRIBED (`describeCredential` never rotates a token and
 * never touches the network), so listing the catalog cannot spend a subscription
 * grant — which the old `detectProviders()`-to-list-models path did on every
 * call.
 */
export async function listChoosableTargets(store?: ResolveOptions["store"]): Promise<ChoosableTarget[]> {
    registerBuiltInPlugins();

    const accounts = await choosableAccounts(store);
    const targets: ChoosableTarget[] = [];

    for (const account of accounts) {
        const plugin = tryProviderPlugin(account.provider);

        if (!plugin?.capabilities.has("chat")) {
            continue;
        }

        const credential = await describeCredential(account, plugin.credential);

        if (!credential.ok) {
            logger.debug(
                { account: account.name, provider: account.provider, detail: credential.detail },
                "account skipped: no usable credential"
            );
            continue;
        }

        const provider = providerNameFor(account.provider);

        for (const entry of await chatModelsFor(account.provider)) {
            targets.push({
                accountId: account.id,
                accountName: account.name,
                ...(account.label ? { accountLabel: account.label } : {}),
                providerId: account.provider,
                provider,
                modelId: entry.id,
                modelName: entry.displayName,
                subscription: plugin.kind === "subscription",
            });
        }
    }

    return targets;
}

async function pickInteractively(store?: ResolveOptions["store"]): Promise<ModelRef | undefined> {
    const targets = await listChoosableTargets(store);

    if (targets.length === 0) {
        return undefined;
    }

    const accounts = [...new Map(targets.map((target) => [target.accountId, target])).values()];
    let accountId = accounts[0].accountId;

    if (accounts.length > 1) {
        const chosen = await p.select({
            message: "Choose account:",
            options: accounts.map((target) => ({
                value: target.accountId,
                label: pc.cyan(target.accountName),
                hint: target.subscription ? `${target.provider} · subscription` : target.provider,
            })),
        });

        if (p.isCancel(chosen)) {
            return undefined;
        }

        accountId = chosen;
    }

    const models = targets.filter((target) => target.accountId === accountId);
    const chosenModel = await searchSelect({
        message: "Choose model:",
        items: models.map((target) => ({ label: target.modelName, value: target.modelId, hint: target.modelId })),
    });

    if (chosenModel === searchSelectCancelSymbol) {
        return undefined;
    }

    return `@account/${accountId}:${chosenModel as string}`;
}

export async function chooseProviderModel(options: ChooseProviderModelOptions = {}): Promise<ResolvedBinding> {
    const resolveOpts: ResolveOptions = {
        ...(options.task ? { task: options.task } : {}),
        ...(options.app ? { app: options.app } : {}),
        ...(options.store ? { store: options.store } : {}),
    };

    const explicit = options.modelRef ?? refFor(options.provider, options.model);

    if (explicit) {
        return resolveModel(explicit, resolveOpts);
    }

    const configured = parseProviderSpec(options.fallbackSpec);
    const fromSpec = refFor(configured.provider, configured.model);

    if (fromSpec) {
        return resolveModel(fromSpec, resolveOpts);
    }

    if (options.interactive && isInteractive()) {
        const picked = await pickInteractively(options.store);

        if (picked) {
            return resolveModel(picked, resolveOpts);
        }
    }

    // Nothing named and nothing picked: the defaults ladder answers, and when it
    // cannot it throws naming the command that fixes it.
    return resolveModel(undefined, resolveOpts);
}
