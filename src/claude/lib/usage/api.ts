import type { AccountConfig } from "@app/claude/lib/config";
import { loadConfig, saveConfig, withConfigLock } from "@app/claude/lib/config";
import { refreshOAuthToken } from "@app/utils/claude/auth";

export type { AccountInfo, KeychainCredentials } from "@app/utils/claude/auth";

export class RateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RateLimitError";
    }
}

// Refresh tokens 5 minutes before expiry to avoid edge cases
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface UsageBucket {
    utilization: number;
    resets_at: string | null;
}

export interface UsageResponse {
    five_hour: UsageBucket;
    seven_day: UsageBucket;
    seven_day_opus?: UsageBucket | null;
    seven_day_sonnet?: UsageBucket | null;
    seven_day_oauth_apps?: UsageBucket | null;
    [key: string]: UsageBucket | null | undefined;
}

export interface AccountUsage {
    accountName: string;
    label?: string;
    usage?: UsageResponse;
    error?: string;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function fetchUsage(accessToken: string, signal?: AbortSignal): Promise<UsageResponse> {
    const res = await fetch(USAGE_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
        },
        signal,
    });
    if (res.status === 429) {
        const body = await res.text().catch(() => "");
        throw new RateLimitError(`Usage API 429: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Usage API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<UsageResponse>;
}

/**
 * Check if an account's token needs refresh and refresh if possible.
 * Persists new tokens to disk immediately under a file lock to prevent
 * token loss on crash (refresh tokens are single-use).
 */
async function ensureValidToken(
    accountName: string,
    account: AccountConfig,
    options?: { forceRefresh?: boolean }
): Promise<{ accessToken: string; refreshed: boolean }> {
    if (!options?.forceRefresh) {
        // No refresh token? Can't auto-refresh
        if (!account.refreshToken) {
            return { accessToken: account.accessToken, refreshed: false };
        }

        // Token still valid? No refresh needed
        if (account.expiresAt && account.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
            return { accessToken: account.accessToken, refreshed: false };
        }
    }

    // Need refresh but no refresh token available
    if (!account.refreshToken) {
        return { accessToken: account.accessToken, refreshed: false };
    }

    // Token expired or expiring soon — refresh under file lock
    return withConfigLock(async () => {
        // Re-read config from disk (another process may have refreshed)
        const freshConfig = await loadConfig();
        const diskAccount = freshConfig.accounts[accountName];

        // Another process already refreshed — use their tokens (check before missing refreshToken)
        if (diskAccount?.expiresAt && diskAccount.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
            account.accessToken = diskAccount.accessToken;
            account.refreshToken = diskAccount.refreshToken;
            account.expiresAt = diskAccount.expiresAt;
            return { accessToken: diskAccount.accessToken, refreshed: true };
        }

        if (!diskAccount?.refreshToken) {
            return { accessToken: account.accessToken, refreshed: false };
        }

        // Refresh using the on-disk token (in-memory might be stale)
        let refreshed: Awaited<ReturnType<typeof refreshOAuthToken>>;
        try {
            refreshed = await refreshOAuthToken(diskAccount.refreshToken);
        } catch (err) {
            if (String(err).includes("invalid_grant")) {
                throw new Error(`Token expired (invalid_grant). Run: tools claude login ${accountName}`);
            }

            throw err;
        }

        // Persist immediately BEFORE using the new token
        freshConfig.accounts[accountName] = {
            ...diskAccount,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
        };
        await saveConfig(freshConfig);

        // Update in-memory account
        account.accessToken = refreshed.accessToken;
        account.refreshToken = refreshed.refreshToken;
        account.expiresAt = refreshed.expiresAt;

        return { accessToken: refreshed.accessToken, refreshed: true };
    }, 60_000); // 60s timeout for acquiring the config lock; refresh holds the lock while running
}

export async function fetchAllAccountsUsage(
    accounts: Record<string, AccountConfig>,
    signal?: AbortSignal
): Promise<AccountUsage[]> {
    const entries = Object.entries(accounts);
    if (entries.length === 0) {
        return [];
    }

    const results = await Promise.allSettled(
        entries.map(async ([name, account]) => {
            const { accessToken } = await ensureValidToken(name, account);
            const usage = await fetchUsage(accessToken, signal);
            return { accountName: name, label: account.label, usage } satisfies AccountUsage;
        })
    );

    return results.map((r, i) =>
        r.status === "fulfilled"
            ? r.value
            : { accountName: entries[i][0], label: entries[i][1].label, error: String(r.reason) }
    );
}
