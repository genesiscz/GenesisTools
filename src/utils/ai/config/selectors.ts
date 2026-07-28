import type { AccountEntry } from "./schema";

/**
 * Derived answers about an account. These are FUNCTIONS over the account's
 * declared shape rather than stored booleans, so adding a provider or a billing
 * mode gets correct behavior everywhere without touching any config file. The
 * `overrides` map exists only to force an exception.
 */

function override(account: AccountEntry, key: string): boolean | undefined {
    const value = account.overrides?.[key];
    return typeof value === "boolean" ? value : undefined;
}

/** Does using this account spend metered, per-token money? */
export function isBilled(account: AccountEntry): boolean {
    return override(account, "billed") ?? account.billing.mode !== "free";
}

/** Should this account appear in usage dashboards (which track spend/limits)? */
export function showsInUsageDashboard(account: AccountEntry): boolean {
    return override(account, "usageDashboard") ?? (account.enabled && account.billing.mode !== "free");
}

/**
 * May ai-proxy serve this account to clients? Subscription accounts stay
 * owner-only elsewhere (ToS), but that is the proxy's client-scoping rule, not
 * an account property, so the default here is permissive.
 */
export function isProxyEligible(account: AccountEntry): boolean {
    return override(account, "proxyEligible") ?? account.enabled;
}

/** Env fallback var names this account allows, in order. Empty means env is off. */
export function envKeyNames(account: AccountEntry, providerDefaults: readonly string[]): string[] {
    const setting = account.useEnvApiKey;

    if (setting === false || setting === undefined) {
        return [];
    }

    if (setting === true) {
        return [...providerDefaults];
    }

    if (typeof setting === "string") {
        return [setting];
    }

    return [...setting];
}

export function hasStoredCredential(account: AccountEntry): boolean {
    const { apiKey, accessToken, longLivedToken, authFile } = account.credentials;
    return Boolean(apiKey ?? accessToken ?? longLivedToken ?? authFile);
}
