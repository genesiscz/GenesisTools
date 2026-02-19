import { homedir } from "node:os";
import { join } from "node:path";

export interface OAuthProfileAccount {
	uuid: string;
	full_name: string;
	display_name: string;
	email: string;
	has_claude_max: boolean;
	has_claude_pro: boolean;
	created_at: string;
}

export interface OAuthProfileOrganization {
	uuid: string;
	name: string;
	organization_type: string;
	billing_type: string;
	rate_limit_tier: string;
	has_extra_usage_enabled: boolean;
	subscription_status: string;
	subscription_created_at: string;
}

export interface OAuthProfileResponse {
	account: OAuthProfileAccount;
	organization: OAuthProfileOrganization;
}

export interface ClaudeJsonAccount {
	accountUuid?: string;
	emailAddress?: string;
	displayName?: string;
	organizationUuid?: string;
	billingType?: string;
}

export interface AccountInfo {
	api?: OAuthProfileResponse;
	claudeJson?: ClaudeJsonAccount;
}

export interface KeychainCredentials {
	accessToken: string;
	subscriptionType?: string;
	rateLimitTier?: string;
	account: AccountInfo;
}

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfileResponse | undefined> {
	try {
		const res = await fetch(PROFILE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				Accept: "application/json",
			},
		});
		if (!res.ok) return undefined;
		return (await res.json()) as OAuthProfileResponse;
	} catch {
		return undefined;
	}
}

export async function getClaudeJsonAccount(): Promise<ClaudeJsonAccount | undefined> {
	try {
		const file = Bun.file(join(homedir(), ".claude.json"));
		const data = await file.json();
		const acct = data?.oauthAccount;
		if (!acct) return undefined;
		return {
			accountUuid: acct.accountUuid,
			emailAddress: acct.emailAddress,
			displayName: acct.displayName,
			organizationUuid: acct.organizationUuid,
			billingType: acct.billingType,
		};
	} catch {
		return undefined;
	}
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

		const [api, claudeJson] = await Promise.all([
			fetchOAuthProfile(oauth.accessToken),
			getClaudeJsonAccount(),
		]);

		return {
			accessToken: oauth.accessToken,
			subscriptionType: oauth.subscriptionType,
			rateLimitTier: oauth.rateLimitTier,
			account: { api, claudeJson },
		};
	} catch {
		return null;
	}
}
