import type { ModelsCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import type { CatalogOptions } from "@app/ai-proxy/lib/model-meta";
import type { ProviderInspectionOptions, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { ProxyAgent } from "@app/ai-proxy/lib/sessions/view";
import type { AiProxyAccountConfig, ProxyModelMeta, UsageSummary } from "@app/ai-proxy/lib/types";
import type { AccountBillingSnapshot } from "@app/ai-proxy/lib/usage/types";

/**
 * The `ProviderPlugin` ids (`@genesiscz/utils/ai/providers/plugins`) whose AI-config accounts this proxy can serve.
 * The link from a plugin to its proxy provider lives here, in the tool, because `@genesiscz/utils` never imports a
 * tool: a `plugin.proxy()` member on the shared plugin would need exactly that import.
 */
export type ProxyPluginId = "openai-sub" | "anthropic-sub" | "grok-sub" | "xai" | "openai" | "openrouter";

/**
 * How an account of the provider pays. A subscription seat is owner-only, because serving it to a third party is
 * resale. An API key is metered per token, and the account reads it from an env var unless it stores one.
 */
export type ProviderBilling =
    | {
          readonly plane: "subscription";
          /** Where the OAuth token comes from when the account names no AI-config login. */
          nativeSource(account: AiProxyAccountConfig): string;
      }
    | {
          readonly plane: "api-key";
          /** The env var that holds the key when the account names none (`apiKeyEnv`). */
          envName(): string;
      };

/** The AI-config login an account names in its own provider block (`grok.accountName`, `openaiSub.accountName`). */
export interface ProviderLogin {
    name(account: AiProxyAccountConfig): string | undefined;
    /** A copy of the account that names `login`. */
    bind(account: AiProxyAccountConfig, login: string): AiProxyAccountConfig;
}

/** Moving to another login when the account fails (`failover`). */
export interface ProviderFailover {
    /** The logins the account moves to, in order. */
    accounts(account: AiProxyAccountConfig): string[];
}

export interface UpstreamEndpoint {
    readonly method: string;
    readonly path: string;
}

/** What `update-models` writes into the models catalog file for one account, or why it skipped the account. */
export type CatalogEntryResult =
    | { readonly entry: ModelsCatalogFile["accounts"][number]; readonly dropped: number }
    | { readonly skipped: string };

/** One provider's models: the list `/v1/models` advertises for an account, and the facts around that list. */
export interface ModelSource {
    /** The models the account advertises (`/v1/models`, `tools ai-proxy models`). */
    list(account: AiProxyAccountConfig, options?: CatalogOptions): Promise<ProxyModelMeta[]>;
    /** Files whose change must rebuild the account's cached list, because the list depends on the login in them. */
    cacheFiles(account: AiProxyAccountConfig): string[];
    /** The id a usage row and an invoice book for `upstreamId`: an alias as its concrete model, any other id as is. */
    bookedId(upstreamId: string): string;
    /** True when the account serves any slashed id the shared OpenRouter catalog lists (`anthropic/claude-sonnet-5`). */
    readonly servesCatalogIds: boolean;
    /** What `accounts list` says about an enabled account with no model; null for the wording every provider shares. */
    readonly emptyHint: string | null;
    /**
     * Asks the upstream for the account's models and returns its models catalog entry (`update-models`), which `list`
     * reads back. null: the provider keeps no entry in that file.
     */
    readonly catalogEntry:
        | ((account: AiProxyAccountConfig, options: { probe: boolean }) => Promise<CatalogEntryResult>)
        | null;
}

/** One provider's usage, beyond the live read and its summary line (`ProxyProvider.getUsage`). */
export interface UsageSource {
    /**
     * The billing store's copy of a live read, which `tools ai-proxy usage` shows while the account cannot answer, or
     * null when the read carries none of this provider's details. null itself: the store keeps nothing for it.
     */
    readonly snapshot:
        | ((usage: Pick<UsageSummary, "tier" | "summary" | "details">) => AccountBillingSnapshot | null)
        | null;
}

/**
 * Everything the proxy knows about one provider type, in one object. Callers ask a member and never compare the
 * provider's name; `PROVIDER_DEFINITIONS` in `registry.ts` maps every `AiProxyProviderType` to one of these.
 */
export interface ProviderDefinition {
    /** The vendor's name in a detect report. */
    readonly title: string;
    /** The slug an account of this type gets when the proxy builds one (an `@account/…` ref, a session login). */
    readonly defaultSlug: string;
    /** The upstream agent the provider serves, for session views and session routing. */
    readonly agent: ProxyAgent;
    /** The same vendor's `ProviderPlugin`, whose AI-config accounts this provider serves; null for none. */
    readonly plugin: ProxyPluginId | null;
    readonly billing: ProviderBilling;
    /** The login an account names; null when an account names none (an API key, a token file of its own). */
    readonly login: ProviderLogin | null;
    /** null when an account of this provider never moves to another login. */
    readonly failover: ProviderFailover | null;
    readonly models: ModelSource;
    readonly usage: UsageSource;
    /** The upstream endpoints the account calls, for `introspect` and the models catalog file; null when unlisted. */
    readonly upstreamEndpoints: readonly UpstreamEndpoint[] | null;
    /** Builds the provider. `probe` builds it for a diagnostic, which must never spend a single-use grant. */
    create(account: AiProxyAccountConfig, options?: ProviderInspectionOptions): Promise<ProxyProvider>;
    /** A model id a detect report suggests, one a client can call. */
    suggestedModel(account: AiProxyAccountConfig): string;
    /** `introspect`'s lines about the account's upstream and login; [] when there is nothing beyond its provider line. */
    introspect(account: AiProxyAccountConfig): Promise<string[]>;
}
