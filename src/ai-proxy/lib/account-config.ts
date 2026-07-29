import { createHash } from "node:crypto";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { copilotDataDir } from "@genesiscz/utils/ai/github-copilot/paths";
import type { CopilotAccountType } from "@genesiscz/utils/ai/github-copilot/types";
import { grokAuthPath } from "@genesiscz/utils/ai/grok";
import { SafeJSON } from "@genesiscz/utils/json";

type LegacyAccountFields = {
    grokAuthPath?: string;
    copilotDataDir?: string;
    copilotAccountType?: CopilotAccountType;
};

export function resolveGrokAuthPath(account: AiProxyAccountConfig): string {
    return account.grok?.authPath ?? grokAuthPath();
}

export function resolveGithubCopilotDataDir(account: AiProxyAccountConfig): string {
    return copilotDataDir(account.githubCopilot?.dataDir);
}

export interface AccountCredentialDescription {
    /** Where the credential comes from — never the credential itself. */
    source: string;
    /** True when using this account spends metered, per-token money. */
    billed: boolean;
}

/**
 * Describe (never resolve, never print) an account's credential so startup and
 * per-request logs can say which door each account walks through. `billed`
 * separates a subscription seat, which costs nothing extra per call, from a
 * platform API key, which does.
 */
export function describeAccountCredential(account: AiProxyAccountConfig): AccountCredentialDescription {
    if (account.provider === "xai-api-key" || account.provider === "openai") {
        const envName = account.apiKeyEnv ?? (account.provider === "openai" ? "OPENAI_API_KEY" : "XAI_API_KEY");
        // Trimmed, because that is what the resolvers do: a whitespace-only
        // `apiKey` falls through to the env var, and this log must say so.
        const configured = account.apiKey?.trim();

        return {
            source: configured ? "config apiKey" : `env ${envName}`,
            billed: true,
        };
    }

    if (account.provider === "grok-subscription") {
        return {
            source: account.grok?.accountName
                ? `ai config account "${account.grok.accountName}" (OAuth)`
                : `OAuth ${resolveGrokAuthPath(account)}`,
            billed: false,
        };
    }

    if (account.provider === "github-copilot-subscription") {
        return { source: `OAuth ${resolveGithubCopilotDataDir(account)}`, billed: false };
    }

    if (account.provider === "anthropic-subscription") {
        return {
            source: account.anthropicSub?.accountName
                ? `ai config account "${account.anthropicSub.accountName}" (OAuth)`
                : "OAuth (anthropic subscription)",
            billed: false,
        };
    }

    if (account.provider === "openai-subscription") {
        return {
            source: account.openaiSub?.accountName
                ? `ai config account "${account.openaiSub.accountName}" (OAuth)`
                : "OAuth (codex auth.json)",
            billed: false,
        };
    }

    return { source: "unknown", billed: false };
}

export function accountConfigFingerprint(account: AiProxyAccountConfig): string {
    const configuredKey = account.apiKey?.trim();

    return SafeJSON.stringify({
        provider: account.provider,
        baseUrl: account.baseUrl,
        realtimeBaseUrl: account.realtimeBaseUrl,
        grok: account.grok,
        githubCopilot: account.githubCopilot,
        anthropicSub: account.anthropicSub,
        openaiSub: account.openaiSub,
        apiKey: configuredKey ? createHash("sha256").update(configuredKey).digest("hex").slice(0, 12) : undefined,
        allowEnvApiKey: account.allowEnvApiKey,
        apiKeyEnv: account.apiKeyEnv,
        managementKeyEnv: account.managementKeyEnv,
        teamId: account.teamId,
    });
}

export function migrateAccountConfig(account: AiProxyAccountConfig & LegacyAccountFields): AiProxyAccountConfig {
    const {
        grokAuthPath: legacyGrokAuthPath,
        copilotDataDir: legacyCopilotDataDir,
        copilotAccountType,
        ...base
    } = account;

    const authPath = base.grok?.authPath ?? legacyGrokAuthPath;
    const grok = authPath ? { ...base.grok, authPath } : base.grok;

    const dataDir = base.githubCopilot?.dataDir ?? legacyCopilotDataDir;
    const type = base.githubCopilot?.type ?? copilotAccountType;
    const githubCopilot =
        dataDir || type
            ? { ...base.githubCopilot, ...(dataDir ? { dataDir } : {}), ...(type ? { type } : {}) }
            : base.githubCopilot;

    return {
        ...base,
        ...(grok ? { grok } : {}),
        ...(githubCopilot ? { githubCopilot } : {}),
    };
}
