import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { resolveProxyAccountEntry } from "@app/ai-proxy/lib/account-refs";
import { defaultApiKeyEnvName } from "@app/ai-proxy/lib/providers/api-key-state";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { copilotDataDir } from "@genesiscz/utils/ai/github-copilot/paths";
import type { CopilotAccountType } from "@genesiscz/utils/ai/github-copilot/types";
import { grokAuthPath } from "@genesiscz/utils/ai/grok";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { redactSecrets, securityStorage } from "@genesiscz/utils/security";

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
        const envName = defaultApiKeyEnvName(account);
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

/**
 * The fingerprint a LONG-RUNNING proxy must watch.
 *
 * `accountConfigFingerprint` only sees this tool's own config, so a credential
 * edited in `tools ai config` — or a token rotated into the vault — left the
 * serve process holding a provider built from the old secret until someone
 * restarted it. This adds the two things that change out there: the referenced
 * AccountEntry's structure (never its secret VALUES, which stay in the vault),
 * and the vault file's mtime, which moves on every secret write.
 *
 * The vault is stamped by mtime rather than by decrypting each entry because
 * this runs on every request: a stat is free, while a decrypt needs the master
 * key and would put a keychain prompt in the request path.
 */
export async function accountBindingFingerprint(account: AiProxyAccountConfig): Promise<string> {
    const parts: Record<string, unknown> = { config: accountConfigFingerprint(account) };

    try {
        const store = await AiConfigStore.load();
        const entry = resolveProxyAccountEntry(account, store);

        if (entry) {
            parts.account = {
                id: entry.id,
                name: entry.name,
                provider: entry.provider,
                enabled: entry.enabled,
                endpoint: entry.endpoint,
                useEnvApiKey: entry.useEnvApiKey,
                // Structure only: a literal credential is hashed, a SecureRef
                // contributes its path and is covered by the vault stamp below.
                credentials: SafeJSON.stringify(redactSecrets(entry.credentials)),
            };
            parts.vault = vaultStamp();
        }
    } catch (err) {
        // A missing/unreadable AI config must not stop the proxy from serving the
        // accounts whose credentials live entirely in its own config.
        logger.debug({ err, account: account.name }, "ai-proxy: binding fingerprint fell back to the config-only hash");
    }

    return createHash("sha256")
        .update(SafeJSON.stringify(parts) ?? "")
        .digest("hex")
        .slice(0, 32);
}

/** Epoch ms of the last vault write, or 0 when there is no vault yet. */
function vaultStamp(): number {
    try {
        return statSync(join(securityStorage().getBaseDir(), "vault.json")).mtimeMs;
    } catch (err) {
        logger.debug({ err }, "ai-proxy: no vault file to stamp");
        return 0;
    }
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
