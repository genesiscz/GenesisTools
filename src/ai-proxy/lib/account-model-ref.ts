import { describeAccountCredential } from "@app/ai-proxy/lib/account-config";
import { legacyAccountNameOf, proxyAccountRefOf } from "@app/ai-proxy/lib/account-refs";
import { isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import { resolveModel, splitReasoningEffortSuffix } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxyAccountConfig, AiProxyProviderType, ResolvedRoute } from "@app/ai-proxy/lib/types";
import { accountRef, accountRefIn, refToId } from "@genesiscz/utils/ai/config/refs";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { isGateOnly, isProxyEligible } from "@genesiscz/utils/ai/config/selectors";
import { logger } from "@genesiscz/utils/logger";

const ACCOUNT_MODEL_PREFIX = "@account/";

/**
 * How an AI-config account is served when no proxy account links to it. Only the
 * providers the proxy has an implementation for; anything else is refused by name.
 */
const SYNTHESIZED: Record<string, { provider: AiProxyProviderType; providerSlug: string; apiKey: boolean }> = {
    "grok-sub": { provider: "grok-subscription", providerSlug: "grok", apiKey: false },
    "anthropic-sub": { provider: "anthropic-subscription", providerSlug: "claude-sub", apiKey: false },
    "openai-sub": { provider: "openai-subscription", providerSlug: "codex", apiKey: false },
    xai: { provider: "xai-api-key", providerSlug: "xai", apiKey: true },
    openai: { provider: "openai", providerSlug: "openai", apiKey: true },
    openrouter: { provider: "openrouter", providerSlug: "openrouter", apiKey: true },
};

export interface AccountModelRef {
    /** The part after `@account/`: an immutable id, or a name as `AiConfigStore.account` accepts. */
    account: string;
    upstreamId: string;
}

export interface AccountRouteDeps {
    /** `AiConfigStore.account`: id first, then a unique name. */
    lookupAccount: (idOrName: string) => AccountEntry | undefined;
    /** The account's API key through the shared credential chokepoint. */
    resolveApiKey: (account: AccountEntry) => Promise<string>;
}

export function isAccountModelRef(model: string): boolean {
    return model.trim().startsWith(ACCOUNT_MODEL_PREFIX);
}

/** `@account/<id>:<model>`, the core ModelRef grammar (src/utils/ai/core/model-ref.ts). */
export function parseAccountModelRef(model: string): AccountModelRef {
    const trimmed = model.trim();
    const ref = accountRefIn(trimmed);

    if (!ref) {
        throw new Error(`Model id must be @account/<id>:<model>, got: ${model}`);
    }

    const account = refToId(ref);
    const upstreamId = trimmed.slice(ACCOUNT_MODEL_PREFIX.length + account.length + 1).trim();

    if (!trimmed.slice(ACCOUNT_MODEL_PREFIX.length + account.length).startsWith(":") || !upstreamId) {
        throw new Error(`Model id must be @account/<id>:<model> (the model after the colon is missing), got: ${model}`);
    }

    return { account, upstreamId };
}

function linksTo(proxyAccount: AiProxyAccountConfig, entry: AccountEntry): boolean {
    const ref = proxyAccountRefOf(proxyAccount);

    if (ref) {
        return refToId(ref) === entry.id;
    }

    return legacyAccountNameOf(proxyAccount) === entry.name;
}

/**
 * Route `@account/<id>:<model>` to that AI-config account.
 *
 * A configured proxy account that already bills the same AI account wins, so its
 * settings (base URL, env opt-in, the ledger name) keep applying. Otherwise an
 * in-memory proxy account is built from the AI-config entry; it is never saved.
 * Its name carries an `account:` prefix so it can never share a provider-map key
 * with a configured account of the same name.
 *
 * Refused: an unknown or disabled account, a `gate-only` account (those are for
 * `tools ai gate` alone, and the proxy spending one would skip the approval), and
 * a provider the proxy has no implementation for.
 */
export async function resolveAccountModelRoute(
    proxyModelId: string,
    accounts: AiProxyAccountConfig[],
    deps: AccountRouteDeps
): Promise<ResolvedRoute> {
    const { modelId, reasoningEffort } = splitReasoningEffortSuffix(proxyModelId.trim());
    const parsed = parseAccountModelRef(modelId);
    const entry = deps.lookupAccount(parsed.account);

    if (!entry) {
        throw new Error(
            `No enabled account for model '${proxyModelId}': no AI account '${parsed.account}' (tools ai config account list).`
        );
    }

    if (!entry.enabled) {
        throw new Error(`No enabled account for model '${proxyModelId}': AI account '${entry.name}' is disabled.`);
    }

    if (!isProxyEligible(entry)) {
        throw new Error(
            `No enabled account for model '${proxyModelId}': AI account '${entry.name}' is excluded from the proxy (overrides.proxyEligible).`
        );
    }

    if (isGateOnly(entry)) {
        throw new Error(
            `No enabled account for model '${proxyModelId}': AI account '${entry.name}' is gate-only and serves \`tools ai gate\` alone.`
        );
    }

    const effort = reasoningEffort ? { reasoningEffort } : {};
    const linked = accounts.find(
        (item) => item.enabled && isProviderImplemented(item.provider) && linksTo(item, entry)
    );

    if (linked) {
        logger.debug(
            { account: entry.id, proxyAccount: linked.name },
            "ai-proxy: @account ref routed to its linked proxy account"
        );
        return {
            accountName: linked.name,
            providerSlug: linked.providerSlug,
            upstreamId: parsed.upstreamId,
            account: await boundToEntry(proxyModelId, linked, entry, deps),
            ...effort,
        };
    }

    const shape = SYNTHESIZED[entry.provider];

    if (!shape) {
        throw new Error(
            `No enabled account for model '${proxyModelId}': the proxy cannot serve ${entry.provider} accounts (supported: ${Object.keys(SYNTHESIZED).join(", ")}).`
        );
    }

    const account: AiProxyAccountConfig = {
        name: `account:${entry.name}`,
        label: entry.label ?? entry.name,
        provider: shape.provider,
        providerSlug: shape.providerSlug,
        enabled: true,
        account: accountRef(entry.id),
        ...(entry.endpoint && shape.apiKey ? { baseUrl: entry.endpoint } : {}),
        ...(shape.provider === "grok-subscription" ? { grok: { accountName: entry.name } } : {}),
        ...(shape.provider === "anthropic-subscription" ? { anthropicSub: { accountName: entry.name } } : {}),
        ...(shape.provider === "openai-subscription" ? { openaiSub: { accountName: entry.name } } : {}),
        ...(shape.apiKey ? { apiKey: await apiKeyFor(proxyModelId, entry, deps) } : {}),
    };

    logger.debug(
        { account: entry.id, provider: shape.provider },
        "ai-proxy: @account ref routed to an in-memory proxy account"
    );

    return {
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: parsed.upstreamId,
        account,
        ...effort,
    };
}

/**
 * A linked proxy account, bound to the referenced AI account's own credential. A ref-only entry
 * (`account: @account/<id>` with no `*.accountName` or key) would otherwise reach its provider
 * with nothing that names the account, and bill the default auth file or an ambient key.
 */
async function boundToEntry(
    proxyModelId: string,
    linked: AiProxyAccountConfig,
    entry: AccountEntry,
    deps: AccountRouteDeps
): Promise<AiProxyAccountConfig> {
    const shape = SYNTHESIZED[entry.provider];
    const needsKey = shape?.apiKey === true && !linked.apiKey && !linked.apiKeyEnv;

    return {
        ...linked,
        ...(linked.provider === "grok-subscription" && !linked.grok?.accountName
            ? { grok: { ...linked.grok, accountName: entry.name } }
            : {}),
        ...(linked.provider === "anthropic-subscription" && !linked.anthropicSub?.accountName
            ? { anthropicSub: { ...linked.anthropicSub, accountName: entry.name } }
            : {}),
        ...(linked.provider === "openai-subscription" && !linked.openaiSub?.accountName
            ? { openaiSub: { ...linked.openaiSub, accountName: entry.name } }
            : {}),
        ...(needsKey ? { apiKey: await apiKeyFor(proxyModelId, entry, deps) } : {}),
    };
}

/** The message names the account and the fix command, never the key; the prefix makes it a 400. */
async function apiKeyFor(proxyModelId: string, entry: AccountEntry, deps: AccountRouteDeps): Promise<string> {
    try {
        return await deps.resolveApiKey(entry);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`No enabled account for model '${proxyModelId}': ${reason}`);
    }
}

async function defaultDeps(): Promise<AccountRouteDeps> {
    const [{ AiConfigStore }, { registerBuiltInPlugins }, { tryProviderPlugin }, { resolveCredential }] =
        await Promise.all([
            import("@genesiscz/utils/ai/config/AiConfigStore"),
            import("@genesiscz/utils/ai/providers/plugins"),
            import("@genesiscz/utils/ai/providers/registry"),
            import("@genesiscz/utils/ai/providers/credentials"),
        ]);
    const store = await AiConfigStore.load();
    registerBuiltInPlugins();

    return {
        lookupAccount: (idOrName) => store.account(idOrName),
        resolveApiKey: async (entry) => {
            const spec = tryProviderPlugin(entry.provider)?.credential ?? {
                fields: ["apiKey"],
                envKeys: [],
                required: ["apiKey"],
            };
            const resolved = await resolveCredential(entry, spec);

            if (!resolved.apiKey) {
                throw new Error(`AI account '${entry.name}' has no API key.`);
            }

            return resolved.apiKey;
        },
    };
}

/**
 * Every route the proxy serves: the core `@account/<id>:<model>` grammar, else the
 * proxy's own `<account>/<provider>/<model>` grammar (`resolveModel`).
 */
export async function resolveProxyRoute(
    proxyModelId: string,
    accounts: AiProxyAccountConfig[],
    deps?: AccountRouteDeps
): Promise<ResolvedRoute> {
    if (!isAccountModelRef(proxyModelId)) {
        return resolveModel(proxyModelId, accounts);
    }

    return resolveAccountModelRoute(proxyModelId, accounts, deps ?? (await defaultDeps()));
}

/**
 * The 400 for a route whose provider lacks realtime or speech-to-text. Only the
 * API-key providers carry those endpoints, so a subscription account gets told
 * which kind of account to name instead.
 */
export function unsupportedCapabilityMessage(route: ResolvedRoute, capability: string): string {
    const base = `Provider "${route.account.provider}" does not support ${capability}`;

    if (describeAccountCredential(route.account).billed) {
        return base;
    }

    return `${base}: "${route.accountName}" is a subscription account. Name an API-key account (xai or openai) instead, e.g. @account/<id>:<model>.`;
}
