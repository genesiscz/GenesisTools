import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { copilotDataDir } from "@app/utils/ai/github-copilot/paths";
import type { CopilotAccountType } from "@app/utils/ai/github-copilot/types";
import { grokAuthPath } from "@app/utils/ai/grok";
import { SafeJSON } from "@app/utils/json";

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

export function accountConfigFingerprint(account: AiProxyAccountConfig): string {
    return SafeJSON.stringify({
        provider: account.provider,
        baseUrl: account.baseUrl,
        grok: account.grok,
        githubCopilot: account.githubCopilot,
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
