import type { AccountConfig } from "../config";
import { loadConfig, saveConfig } from "../config";
import { refreshOAuthToken } from "@app/utils/claude/auth";
export type { AccountInfo, KeychainCredentials } from "@app/utils/claude/auth";
export { getKeychainCredentials } from "@app/utils/claude/auth";

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

export async function fetchUsage(accessToken: string): Promise<UsageResponse> {
	const res = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Usage API ${res.status}: ${body.slice(0, 200)}`);
	}
	return res.json() as Promise<UsageResponse>;
}

/**
 * Check if an account's token needs refresh and refresh if possible.
 * Returns the (possibly updated) access token.
 */
async function ensureValidToken(
	accountName: string,
	account: AccountConfig,
): Promise<{ accessToken: string; refreshed: boolean }> {
	// No refresh token? Can't auto-refresh
	if (!account.refreshToken) {
		return { accessToken: account.accessToken, refreshed: false };
	}

	// Token still valid? No refresh needed
	const now = Date.now();
	if (account.expiresAt && account.expiresAt > now + EXPIRY_BUFFER_MS) {
		return { accessToken: account.accessToken, refreshed: false };
	}

	// Token expired or expiring soon — refresh it
	const refreshed = await refreshOAuthToken(account.refreshToken);

	// Update in-memory account so subsequent polls use fresh tokens
	// (Critical: refresh tokens are single-use, old RT is now invalid)
	account.accessToken = refreshed.accessToken;
	account.refreshToken = refreshed.refreshToken;
	account.expiresAt = refreshed.expiresAt;

	// Also persist to disk for restarts
	const config = await loadConfig();
	if (config.accounts[accountName]) {
		config.accounts[accountName].accessToken = refreshed.accessToken;
		config.accounts[accountName].refreshToken = refreshed.refreshToken;
		config.accounts[accountName].expiresAt = refreshed.expiresAt;
		await saveConfig(config);
	}

	return { accessToken: refreshed.accessToken, refreshed: true };
}

export async function fetchAllAccountsUsage(
	accounts: Record<string, AccountConfig>,
): Promise<AccountUsage[]> {
	const entries = Object.entries(accounts);
	if (entries.length === 0) return [];

	const results = await Promise.allSettled(
		entries.map(async ([name, account]) => {
			// Auto-refresh expired tokens
			const { accessToken } = await ensureValidToken(name, account);
			const usage = await fetchUsage(accessToken);
			return { accountName: name, label: account.label, usage } satisfies AccountUsage;
		}),
	);

	return results.map((r, i) =>
		r.status === "fulfilled"
			? r.value
			: { accountName: entries[i][0], label: entries[i][1].label, error: String(r.reason) },
	);
}
