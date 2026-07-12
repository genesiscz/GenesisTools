import { appendFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { retry } from "@app/utils/async";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
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
 * Returns true for errors where the refresh request provably never reached
 * token issuance, so retrying the SAME refresh token is safe: 5xx responses
 * and connection-refused. Ambiguous failures (ECONNRESET, ETIMEDOUT, socket
 * hang up) are NOT retried — the server may have already rotated the
 * single-use refresh token before the connection died, and re-sending the
 * consumed token is a reuse signal that can revoke the whole grant family.
 * The next poll retries naturally if the token was never consumed.
 */
function isTransientRefreshError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b5\d{2}\b/.test(msg)) {
        return true;
    }

    if (/ECONNREFUSED/i.test(msg)) {
        return true;
    }

    return false;
}

/**
 * Per-account cooldown after invalid_grant. A dead refresh token stays dead
 * until re-login; without this every poll re-hammers the token endpoint with
 * a known-dead token (~1 POST/30s per consumer).
 */
const INVALID_GRANT_COOLDOWN_MS = 10 * 60 * 1000;
const invalidGrantAt = new Map<string, number>();

/**
 * Append the old and freshly-issued token pair to a journal BEFORE the config
 * write. Refresh tokens are single-use: if the process dies (or the write is
 * lost) between Anthropic issuing the new pair and the config save, the new
 * pair exists nowhere else and the account is bricked until re-login. The
 * journal makes that window recoverable. Same sensitivity as config.json
 * (plaintext tokens), so chmod 600. Failures never block the refresh itself.
 */
function journalTokenRotation(account: string, oldTokens: Partial<OAuthTokens>, newTokens: OAuthTokens): void {
    try {
        const dir = join(env.tools.getHome() || homedir(), ".genesis-tools", "ai");
        const path = join(dir, "token-journal.jsonl");
        appendFileSync(
            path,
            `${SafeJSON.stringify({
                ts: new Date().toISOString(),
                account,
                oldAccessToken: oldTokens.accessToken,
                oldRefreshToken: oldTokens.refreshToken,
                newAccessToken: newTokens.accessToken,
                newRefreshToken: newTokens.refreshToken,
                newExpiresAt: newTokens.expiresAt,
            })}\n`,
            { mode: 0o600 }
        );

        chmodSync(path, 0o600);
    } catch (err) {
        logger.warn({ err, account }, "[token-refresh] journal append failed");
    }
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
 * - Retries only errors where the single-use refresh token provably wasn't
 *   consumed (5xx, ECONNREFUSED) up to 2 times with 1s fixed delay
 * - Detects invalid_grant, applies a per-account cooldown, and provides an
 *   actionable error message
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

    const lastInvalidGrant = invalidGrantAt.get(name);
    if (lastInvalidGrant && Date.now() - lastInvalidGrant < INVALID_GRANT_COOLDOWN_MS) {
        throw new Error(`Token expired (invalid_grant). Run: tools claude login ${name}`);
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
                invalidGrantAt.set(name, Date.now());
                throw new Error(`Token expired (invalid_grant). Run: tools claude login ${name}`);
            }

            throw new Error(
                `Failed to refresh token for "${name}": ${err instanceof Error ? err.message : err}. ` +
                    `Run \`tools claude login ${name}\` if this persists.`
            );
        }

        journalTokenRotation(name, diskAccount.tokens, newTokens);

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

        invalidGrantAt.delete(name);
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
