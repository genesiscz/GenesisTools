import type { AccountConfig } from "../config";

// --- Types ---

export interface UsageBucket {
	utilization: number;
	resets_at: string | null;
}

export interface UsageResponse {
	five_hour: UsageBucket;
	seven_day: UsageBucket;
	seven_day_opus?: UsageBucket | null;
	seven_day_oauth_apps?: UsageBucket | null;
	[key: string]: UsageBucket | null | undefined;
}

export interface AccountUsage {
	accountName: string;
	email?: string;
	usage?: UsageResponse;
	error?: string;
}

// --- Keychain ---

export interface KeychainCredentials {
	accessToken: string;
	email?: string;
}

export async function getKeychainCredentials(): Promise<KeychainCredentials | null> {
	const proc = Bun.spawn({
		cmd: ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const text = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0 || !text.trim()) return null;

	try {
		const data = JSON.parse(text.trim());
		const oauth = data.claudeAiOauth;
		if (!oauth?.accessToken) return null;
		return {
			accessToken: oauth.accessToken,
			email: data.email ?? oauth.email,
		};
	} catch {
		return null;
	}
}

// --- API ---

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
			return { accountName: name, email: account.email, usage } satisfies AccountUsage;
		}),
	);

	return results.map((r, i) =>
		r.status === "fulfilled"
			? r.value
			: { accountName: entries[i][0], email: entries[i][1].email, error: String(r.reason) },
	);
}
