import { existsSync } from "node:fs";

import { resolveGithubCopilotDataDir } from "@app/ai-proxy/lib/account-config";
import { getAiProxyConfigStore, getDefaultConfig, parseConfigJson, redactConfig } from "@app/ai-proxy/lib/config-store";
import {
    type DetectedAccountReport,
    formatGithubCopilotTokenSource,
    providerTitleFor,
    suggestedModelFor,
} from "@app/ai-proxy/lib/detect-report";
import type { AiProxyAccountConfig, AiProxyConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import {
    fetchCopilotUserInfo,
    fetchGithubUserLogin,
    formatCopilotUsageSummary,
    resolveGithubCopilotGhoToken,
} from "@app/utils/ai/github-copilot";
import { copilotDataDir, githubTokenPath } from "@app/utils/ai/github-copilot/paths";
import {
    formatBillingSummary,
    GrokSubscriptionClient,
    getActiveAuthEntry,
    grokAuthPath,
    readAuthFileAsync,
} from "@app/utils/ai/grok";
import { env } from "@app/utils/env";
import { collapsePath } from "@app/utils/paths";

export { getDefaultConfig, parseConfigJson, redactConfig };

export async function loadConfig(): Promise<AiProxyConfig> {
    return getAiProxyConfigStore().load();
}

export async function loadConfigFresh(): Promise<AiProxyConfig> {
    return getAiProxyConfigStore().loadFresh();
}

export async function saveConfig(config: AiProxyConfig): Promise<void> {
    await getAiProxyConfigStore().save(config);
}

export function inferAccountNameFromEmail(email?: string): string {
    if (!email) {
        return "default";
    }

    const local = email.split("@")[0]?.trim();
    if (!local) {
        return "default";
    }

    return local.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

export function inferAccountNameFromLogin(login?: string): string {
    if (!login?.trim()) {
        return "default";
    }

    return login
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-");
}

export async function detectGrokAccount(authPath?: string): Promise<DetectedAccountReport | null> {
    const resolvedAuthPath = authPath ?? grokAuthPath();

    if (!existsSync(resolvedAuthPath)) {
        return null;
    }

    const entries = await readAuthFileAsync(resolvedAuthPath);
    const active = getActiveAuthEntry(entries);

    if (!active) {
        return null;
    }

    const accountName = inferAccountNameFromEmail(active.email);
    let tier: string | undefined;
    let usage: string | undefined;
    let label = active.email;

    try {
        const client = new GrokSubscriptionClient({ token: active.key, authPath: resolvedAuthPath });
        const settings = await client.getSettings();
        const billing = await client.getBilling();
        tier = settings.subscription_tier_display;
        label = tier ? `${accountName} (${tier})` : (active.email ?? accountName);
        usage = formatBillingSummary(billing);
        label = `${label} — ${usage}`;
    } catch (err) {
        logger.warn(
            { err, authRef: collapsePath(resolvedAuthPath), hasEmail: Boolean(active.email) },
            "ai-proxy: grok account enrichment failed"
        );
        label = active.email ?? accountName;
    }

    const account: AiProxyAccountConfig = {
        name: accountName,
        label,
        provider: "grok-subscription",
        providerSlug: "grok",
        enabled: true,
        grok: { authPath: resolvedAuthPath },
    };

    return {
        account,
        providerTitle: providerTitleFor(account),
        detectedFrom: `Grok auth file (${collapsePath(resolvedAuthPath)})`,
        identity: active.email,
        tier,
        usage,
        authRef: collapsePath(resolvedAuthPath),
        suggestedModel: suggestedModelFor(account),
    };
}

export interface DetectGithubCopilotOptions {
    /** When true, may read Copilot CLI credentials from macOS Keychain (interactive detect only). */
    allowKeychain?: boolean;
}

export async function detectGithubCopilotAccount(
    dataDir?: string,
    options?: DetectGithubCopilotOptions
): Promise<DetectedAccountReport | null> {
    const resolvedDataDir = copilotDataDir(dataDir);
    const resolved = await resolveGithubCopilotGhoToken({
        dataDir: resolvedDataDir,
        allowKeychain: options?.allowKeychain ?? false,
        notifyBeforeKeychain: options?.allowKeychain ?? false,
    });
    const token = resolved?.token;

    if (!token || !resolved) {
        return null;
    }

    let login: string | undefined;
    try {
        login = (await fetchGithubUserLogin(token)) ?? resolved.loginHint ?? undefined;
    } catch (err) {
        logger.debug({ err }, "ai-proxy: optional copilot login lookup failed");
        login = resolved.loginHint ?? undefined;
    }
    const accountName = inferAccountNameFromLogin(login ?? undefined);
    let label = login ? `${login} (GitHub Copilot)` : "GitHub Copilot";
    let tier: string | undefined;
    let usage: string | undefined;

    try {
        const raw = await fetchCopilotUserInfo(token);
        tier = typeof raw.copilot_plan === "string" ? raw.copilot_plan : undefined;
        usage = formatCopilotUsageSummary(raw);
        label = tier ? `${accountName} (${tier}) — ${usage}` : `${accountName} — ${usage}`;
    } catch {
        label = login ?? accountName;
    }

    const account: AiProxyAccountConfig = {
        name: accountName,
        label,
        provider: "github-copilot-subscription",
        providerSlug: "github-copilot",
        enabled: true,
        githubCopilot: {
            dataDir: resolvedDataDir,
            type: "individual",
        },
    };

    return {
        account,
        providerTitle: providerTitleFor(account),
        detectedFrom: formatGithubCopilotTokenSource(resolved.source),
        identity: login,
        tier,
        usage,
        authRef: collapsePath(githubTokenPath(resolvedDataDir)),
        suggestedModel: suggestedModelFor(account),
    };
}

export async function detectXaiApiKeyAccount(name = "default"): Promise<DetectedAccountReport | null> {
    const apiKey = env.x.getApiKey();

    if (!apiKey) {
        return null;
    }

    const apiKeyEnv = env.x.getApiEnvKey() ?? "X_AI_API_KEY";
    const account: AiProxyAccountConfig = {
        name,
        label: `${name} (xAI API key)`,
        provider: "xai-api-key",
        providerSlug: "xai",
        enabled: true,
        apiKeyEnv,
        managementKeyEnv: env.x.getManagementEnvKey(),
        teamId: env.x.getTeamId(),
    };

    const extras: string[] = [`${apiKeyEnv} environment variable`];
    if (account.managementKeyEnv) {
        extras.push(`${account.managementKeyEnv} set`);
    }
    if (account.teamId) {
        extras.push(`team ${account.teamId}`);
    }

    return {
        account,
        providerTitle: providerTitleFor(account),
        detectedFrom: extras.join(", "),
        authRef: apiKeyEnv,
    };
}

export async function detectAccountReports(options?: DetectGithubCopilotOptions): Promise<DetectedAccountReport[]> {
    const reports: DetectedAccountReport[] = [];
    const [grok, copilot] = await Promise.all([detectGrokAccount(), detectGithubCopilotAccount(undefined, options)]);

    if (grok) {
        reports.push(grok);
    }

    if (copilot) {
        const duplicateName = reports.some((report) => report.account.name === copilot.account.name);
        if (duplicateName) {
            copilot.account.name = `${copilot.account.name}-copilot`;
            copilot.suggestedModel = suggestedModelFor(copilot.account);
        }

        reports.push(copilot);
    }

    const xai = await detectXaiApiKeyAccount(grok || copilot ? "work" : "default");

    if (xai) {
        reports.push(xai);
    }

    return reports;
}

export async function detectAccounts(options?: DetectGithubCopilotOptions): Promise<AiProxyAccountConfig[]> {
    const reports = await detectAccountReports(options);
    return reports.map((report) => report.account);
}

export function githubCopilotTokenPath(account?: AiProxyAccountConfig): string {
    const dataDir = account ? resolveGithubCopilotDataDir(account) : copilotDataDir();
    return githubTokenPath(dataDir);
}
