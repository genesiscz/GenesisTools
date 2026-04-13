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
 * List all Anthropic subscription accounts from unified AI config.
 * Returns empty array if no accounts configured.
 */
export async function listAvailableAccounts(): Promise<SubscriptionAccount[]> {
    const { AIConfig } = await import("@app/utils/ai/AIConfig");
    const config = await AIConfig.load();
    return config.getAccountsByProvider("anthropic-sub").map((acc) => ({
        name: acc.name,
        label: acc.label,
        accessToken: acc.tokens.accessToken ?? "",
        refreshToken: acc.tokens.refreshToken,
        expiresAt: acc.tokens.expiresAt,
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
export async function resolveAccountToken(accountName?: string, options?: ResolveOptions): Promise<ResolvedToken> {
    const forceRefresh = options?.forceRefresh ?? false;
    const lockTimeout = options?.lockTimeout ?? 60_000;

    const { AIConfig } = await import("@app/utils/ai/AIConfig");
    const aiConfig = await AIConfig.load();
    const name = accountName ?? aiConfig.getDefaultAccount("ask")?.name;

    const acc = name ? aiConfig.getAccount(name) : undefined;

    if (!name || !acc) {
        throw new Error(
            accountName
                ? `Account "${accountName}" not found in AI config`
                : "No default account configured. Run `tools claude login` first."
        );
    }

    const staleAccessToken = options?.staleAccessToken ?? acc.tokens.accessToken;

    // Fast path: token is valid and no force-refresh requested
    if (!forceRefresh && acc.tokens.expiresAt && !claudeOAuth.needsRefresh(acc.tokens.expiresAt)) {
        return {
            token: acc.tokens.accessToken ?? "",
            account: {
                name,
                label: acc.label,
                accessToken: acc.tokens.accessToken ?? "",
                refreshToken: acc.tokens.refreshToken,
                expiresAt: acc.tokens.expiresAt,
            },
            refreshed: false,
        };
    }

    const caller = forceRefresh ? "force-refresh" : "token-expired";
    logger.info(`[token-refresh] ${name}: initiating refresh (reason: ${caller})`);

    // Slow path: acquire lock, re-read from disk, refresh
    const refreshed = await aiConfig.withLock(async (data) => {
        const diskAccount = data.accounts.find((a) => a.name === name);

        if (!diskAccount) {
            throw new Error(`Account "${name}" not found in config`);
        }

        // Check if another process already refreshed
        if (diskAccount.tokens.expiresAt && !claudeOAuth.needsRefresh(diskAccount.tokens.expiresAt)) {
            if (!forceRefresh || diskAccount.tokens.accessToken !== staleAccessToken) {
                logger.info(
                    `[token-refresh] ${name}: skipped — another process already refreshed ` +
                        `(expires ${new Date(diskAccount.tokens.expiresAt).toISOString()})`
                );
                return diskAccount;
            }
        }

        if (!diskAccount.tokens.refreshToken) {
            logger.warn(`[token-refresh] ${name}: no refresh token available`);
            return null;
        }

        // Refresh with retry on transient errors (5xx, network)
        let newTokens: OAuthTokens;
        try {
            newTokens = await retry(() => claudeOAuth.refresh(diskAccount.tokens.refreshToken!), {
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
                throw new Error(`Token expired (invalid_grant). Run: tools claude login ${name}`);
            }

            throw new Error(
                `Failed to refresh token for "${name}": ${err instanceof Error ? err.message : err}. ` +
                    `Run \`tools claude login ${name}\` if this persists.`
            );
        }

        // Persist by mutating data in place — withLock handles save automatically
        const idx = data.accounts.findIndex((a) => a.name === name);
        data.accounts[idx] = {
            ...diskAccount,
            tokens: {
                ...diskAccount.tokens,
                accessToken: newTokens.accessToken,
                refreshToken: newTokens.refreshToken,
                expiresAt: newTokens.expiresAt,
            },
        };

        logger.info(
            `[token-refresh] ${name}: refreshed successfully ` +
                `(new expires ${new Date(newTokens.expiresAt).toISOString()})`
        );

        return data.accounts[idx];
    }, lockTimeout);

    // No refresh token available — if the token is expired, fail clearly
    if (!refreshed) {
        if (acc.tokens.expiresAt && claudeOAuth.needsRefresh(acc.tokens.expiresAt)) {
            throw new Error(
                `Token for "${name}" is expired and no refresh token is available. ` + `Run: tools claude login ${name}`
            );
        }

        return {
            token: acc.tokens.accessToken ?? "",
            account: {
                name,
                label: acc.label,
                accessToken: acc.tokens.accessToken ?? "",
                refreshToken: acc.tokens.refreshToken,
                expiresAt: acc.tokens.expiresAt,
            },
            refreshed: false,
        };
    }

    return {
        token: refreshed.tokens.accessToken ?? "",
        account: {
            name,
            label: refreshed.label ?? acc.label,
            accessToken: refreshed.tokens.accessToken ?? "",
            refreshToken: refreshed.tokens.refreshToken,
            expiresAt: refreshed.tokens.expiresAt,
        },
        refreshed: true,
    };
}
