import { homedir } from "node:os";
import { join } from "node:path";

export interface OAuthAccountInfo {
	accountUuid?: string;
	emailAddress?: string;
	displayName?: string;
	organizationUuid?: string;
	billingType?: string;
}

export interface KeychainCredentials {
	accessToken: string;
	subscriptionType?: string;
	rateLimitTier?: string;
	account?: OAuthAccountInfo;
}

export async function getClaudeJsonAccount(): Promise<OAuthAccountInfo | undefined> {
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

		const account = await getClaudeJsonAccount();

		return {
			accessToken: oauth.accessToken,
			subscriptionType: oauth.subscriptionType,
			rateLimitTier: oauth.rateLimitTier,
			account,
		};
	} catch {
		return null;
	}
}
