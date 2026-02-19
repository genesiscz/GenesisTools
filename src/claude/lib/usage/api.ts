import type { AccountConfig } from "../config";
export type { AccountInfo, KeychainCredentials } from "@app/utils/claude/auth";
export { getKeychainCredentials } from "@app/utils/claude/auth";

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

export async function fetchAllAccountsUsage(
	accounts: Record<string, AccountConfig>,
): Promise<AccountUsage[]> {
	const entries = Object.entries(accounts);
	if (entries.length === 0) return [];

	const results = await Promise.allSettled(
		entries.map(async ([name, account]) => {
			const usage = await fetchUsage(account.accessToken);
			return { accountName: name, label: account.label, usage } satisfies AccountUsage;
		}),
	);

	return results.map((r, i) =>
		r.status === "fulfilled"
			? r.value
			: { accountName: entries[i][0], label: entries[i][1].label, error: String(r.reason) },
	);
}
