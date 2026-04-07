import { loadConfig, saveConfig, withConfigLock } from "@app/claude/lib/config";
import logger from "@app/logger";
import { retry } from "@app/utils/async";
import type { OAuthTokens } from "./auth";
import { claudeOAuth } from "./auth";

export interface SubscriptionAccount {
    name: string;
    label?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
}

export interface ResolveOptions {
    /** Force refresh even if the token appears valid (e.g., after 429) */
    forceRefresh?: boolean;
    /**
     * The access token the caller currently holds. Used to detect whether
     * another process already refreshed (avoids double-refresh of single-use tokens).
     * Falls back to the on-disk token when omitted.
     */
    staleAccessToken?: string;
    /** Lock timeout in ms. Default: 60_000 */
    lockTimeout?: number;
}

export interface ResolvedToken {
    token: string;
    account: SubscriptionAccount;
    refreshed: boolean;
}

/**
 * Returns true for errors that are transient and worth retrying:
 * 5xx server errors and network-level failures.
 */
function isTransientRefreshError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b5\d{2}\b/.test(msg)) {
        return true;
    }

    if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(msg)) {
        return true;
    }

    return false;
}

/**
 * List all accounts from tools claude config.
 * Returns empty array if no accounts configured.
 */
export async function listAvailableAccounts(): Promise<SubscriptionAccount[]> {
    const config = await loadConfig();
    return Object.entries(config.accounts).map(([name, acc]) => ({
        name,
        label: acc.label,
        accessToken: acc.accessToken,
        refreshToken: acc.refreshToken,
        expiresAt: acc.expiresAt,
    }));
}

/**
 * Resolve a valid access token for the given account (or default account).
 * Refreshes expired tokens automatically with retry on transient errors.
 *
 * Guarantees:
 * - Acquires config file lock before any mutation
 * - Re-reads config from disk inside lock (prevents TOCTOU)
 * - Detects if another process already refreshed (prevents double-refresh of single-use tokens)
 * - Retries on transient errors (5xx, network) up to 2 times with 1s fixed delay
 * - Detects invalid_grant and provides actionable error message
 * - Persists new tokens to disk immediately after refresh, before returning
 */
export async function resolveAccountToken(
    accountName?: string,
    options?: ResolveOptions,
): Promise<ResolvedToken> {
    const forceRefresh = options?.forceRefresh ?? false;
    const lockTimeout = options?.lockTimeout ?? 60_000;

    const config = await loadConfig();
    const name = accountName ?? config.defaultAccount;

    if (!name || !config.accounts[name]) {
        throw new Error(
            accountName
                ? `Account "${accountName}" not found in tools claude config`
                : "No default account configured. Run `tools claude login` first.",
        );
    }

    const acc = config.accounts[name];
    const staleAccessToken = options?.staleAccessToken ?? acc.accessToken;

    // Fast path: token is valid and no force-refresh requested
    if (!forceRefresh && acc.expiresAt && !claudeOAuth.needsRefresh(acc.expiresAt)) {
        return {
            token: acc.accessToken,
            account: { name, label: acc.label, accessToken: acc.accessToken, refreshToken: acc.refreshToken, expiresAt: acc.expiresAt },
            refreshed: false,
        };
    }

    const caller = forceRefresh ? "force-refresh" : "token-expired";
    logger.info(`[token-refresh] ${name}: initiating refresh (reason: ${caller})`);

    // Slow path: acquire lock, re-read from disk, refresh
    const refreshed = await withConfigLock(async () => {
        const freshConfig = await loadConfig();
        const diskAccount = freshConfig.accounts[name];

        if (!diskAccount) {
            throw new Error(`Account "${name}" not found in config`);
        }

        // Check if another process already refreshed
        if (diskAccount.expiresAt && !claudeOAuth.needsRefresh(diskAccount.expiresAt)) {
            if (!forceRefresh || diskAccount.accessToken !== staleAccessToken) {
                logger.info(
                    `[token-refresh] ${name}: skipped — another process already refreshed ` +
                        `(expires ${new Date(diskAccount.expiresAt).toISOString()})`,
                );
                return diskAccount;
            }
        }

        if (!diskAccount.refreshToken) {
            logger.warn(`[token-refresh] ${name}: no refresh token available`);
            return null;
        }

        // Refresh with retry on transient errors (5xx, network)
        let newTokens: OAuthTokens;
        try {
            newTokens = await retry(() => claudeOAuth.refresh(diskAccount.refreshToken!), {
                maxAttempts: 3,
                delay: 1000,
                backoff: "fixed",
                shouldRetry: isTransientRefreshError,
                onRetry: (attempt, retryDelay) => {
                    logger.warn(`[token-refresh] ${name}: retry ${attempt}/2 after ${retryDelay}ms`);
                },
            });
        } catch (err) {
            if (String(err).includes("invalid_grant")) {
                throw new Error(
                    `Token expired (invalid_grant). Run: tools claude login ${name}`,
                );
            }

            throw new Error(
                `Failed to refresh token for "${name}": ${err instanceof Error ? err.message : err}. ` +
                    `Run \`tools claude login ${name}\` if this persists.`,
            );
        }

        // Persist immediately BEFORE returning (refresh tokens are single-use)
        freshConfig.accounts[name] = {
            ...diskAccount,
            accessToken: newTokens.accessToken,
            refreshToken: newTokens.refreshToken,
            expiresAt: newTokens.expiresAt,
        };
        await saveConfig(freshConfig);

        logger.info(
            `[token-refresh] ${name}: refreshed successfully ` +
                `(new expires ${new Date(newTokens.expiresAt).toISOString()})`,
        );

        return freshConfig.accounts[name];
    }, lockTimeout);

    // No refresh token available — return what we have
    if (!refreshed) {
        return {
            token: acc.accessToken,
            account: { name, label: acc.label, accessToken: acc.accessToken, refreshToken: acc.refreshToken, expiresAt: acc.expiresAt },
            refreshed: false,
        };
    }

    return {
        token: refreshed.accessToken,
        account: {
            name,
            label: refreshed.label ?? acc.label,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
        },
        refreshed: true,
    };
}

/**
 * Get account display info for the ask tool footer.
 * Returns { label, name } or null if no account configured.
 */
export async function getAccountDisplayInfo(accountName?: string): Promise<{ label?: string; name: string } | null> {
    try {
        const config = await loadConfig();
        const name = accountName ?? config.defaultAccount;

        if (!name || !config.accounts[name]) {
            return null;
        }

        return {
            label: config.accounts[name].label,
            name,
        };
    } catch {
        return null;
    }
}
