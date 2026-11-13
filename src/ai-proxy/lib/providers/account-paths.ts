import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { copilotDataDir } from "@genesiscz/utils/ai/github-copilot/paths";
import { grokAuthPath } from "@genesiscz/utils/ai/grok";

/**
 * Where a subscription account's local login files live. A leaf: the definition table and the model lists read these
 * paths, and `account-config.ts` reads the table, so the paths cannot live there without an import cycle.
 */
export function resolveGrokAuthPath(account: AiProxyAccountConfig): string {
    return account.grok?.authPath ?? grokAuthPath();
}

export function resolveGithubCopilotDataDir(account: AiProxyAccountConfig): string {
    return copilotDataDir(account.githubCopilot?.dataDir);
}
