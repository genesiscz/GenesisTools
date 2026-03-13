import { loadConfig, saveConfig, withConfigLock } from "@app/claude/lib/config";
import { claudeOAuth } from "./auth";

export interface SubscriptionAccount {
    name: string;
    label?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
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
 * Auto-refreshes expired tokens under config lock (refresh tokens are single-use).
 */
export async function resolveAccountToken(
    accountName?: string
): Promise<{ token: string; account: SubscriptionAccount }> {
    // Use withConfigLock since refresh tokens are single-use
    return withConfigLock(async () => {
        const config = await loadConfig();
        const name = accountName ?? config.defaultAccount;

        if (!name || !config.accounts[name]) {
            throw new Error(
                accountName
                    ? `Account "${accountName}" not found in tools claude config`
                    : "No default account configured. Run `tools claude login` first."
            );
        }

        const acc = config.accounts[name];

        // Check if token needs refresh
        if (acc.refreshToken && acc.expiresAt && claudeOAuth.needsRefresh(acc.expiresAt)) {
            try {
                const newTokens = await claudeOAuth.refresh(acc.refreshToken);
                // Update config with new tokens (refresh token is single-use!)
                acc.accessToken = newTokens.accessToken;
                acc.refreshToken = newTokens.refreshToken;
                acc.expiresAt = newTokens.expiresAt;
                await saveConfig(config);
            } catch {
                // If refresh fails, try using the existing token anyway
                // It might still be valid if the expiry check was overly cautious
            }
        }

        return {
            token: acc.accessToken,
            account: {
                name,
                label: acc.label,
                accessToken: acc.accessToken,
                refreshToken: acc.refreshToken,
                expiresAt: acc.expiresAt,
            },
        };
    });
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
