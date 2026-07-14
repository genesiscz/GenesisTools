import { loadConfig } from "@app/ai-proxy/lib/config";
import { createProvider, providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { maybeSyncBilling } from "@app/ai-proxy/lib/usage/billing-sync";
import {
    getTodayUsageSummary,
    readBillingStore,
    readRecentRequestsForAccount,
    usageStorePaths,
} from "@app/ai-proxy/lib/usage/store";
import type { AccountBillingSnapshot, UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { out } from "@app/logger";
import { formatTokens } from "@app/utils/format";

export interface UsageCommandOptions {
    account?: string;
    json?: boolean;
    recent?: number;
    paths?: boolean;
}

interface UsageCommandResult {
    accountName: string;
    provider: string;
    tier?: string;
    summary: string;
    live?: UsageSummary;
    billing?: Pick<AccountBillingSnapshot, "fetchedAt" | "tier" | "summary">;
    today: ReturnType<typeof getTodayUsageSummary>;
    last?: UsageRequestRecord;
    recent?: UsageRequestRecord[];
    storePaths?: ReturnType<typeof usageStorePaths>;
}

function formatElapsedSeconds(elapsedMs: number): string {
    return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function formatLastRequest(record: UsageRequestRecord): string {
    const model = record.proxyModel.split("/").slice(2).join("/") || record.proxyModel;
    const prompt = record.usage?.prompt_tokens != null ? `prompt=${formatTokens(record.usage.prompt_tokens)}` : null;
    const completion =
        record.usage?.completion_tokens != null ? `completion=${formatTokens(record.usage.completion_tokens)}` : null;
    const usageParts = [prompt, completion].filter(Boolean).join(" ");

    if (usageParts) {
        return `${model} ${record.status} ${formatElapsedSeconds(record.elapsedMs)} ${usageParts}`;
    }

    return `${model} ${record.status} ${formatElapsedSeconds(record.elapsedMs)}`;
}

function formatTodaySummary(today: ReturnType<typeof getTodayUsageSummary>): string {
    const tokenSummary = today.total_tokens > 0 ? `, ${formatTokens(today.total_tokens)} tokens` : "";
    const rateLimits = today.rate_limits > 0 ? ` (${today.rate_limits} rate limits)` : "";

    return `${today.requests} requests${tokenSummary}${rateLimits}`;
}

function billingSnapshot(snapshot?: AccountBillingSnapshot): UsageCommandResult["billing"] {
    if (!snapshot) {
        return undefined;
    }

    return {
        fetchedAt: snapshot.fetchedAt,
        tier: snapshot.tier,
        summary: snapshot.summary,
    };
}

async function fetchLiveUsage(account: AiProxyAccountConfig): Promise<UsageSummary | undefined> {
    if (
        account.provider === "grok-subscription" ||
        account.provider === "github-copilot-subscription" ||
        account.provider === "xai-api-key"
    ) {
        const provider = await createProvider(account);
        return provider.getUsage();
    }

    return undefined;
}

async function buildAccountUsage(
    account: AiProxyAccountConfig,
    providers: Map<string, ProxyProvider>,
    options: UsageCommandOptions
): Promise<UsageCommandResult> {
    if (account.provider === "grok-subscription" || account.provider === "github-copilot-subscription") {
        const key = providerKey(account);

        if (!providers.has(key)) {
            providers.set(key, await createProvider(account));
        }

        await maybeSyncBilling(account, providers);
    }

    const cachedBilling = readBillingStore().accounts[account.name];
    const today = getTodayUsageSummary(account.name);
    const recentLimit = options.recent ?? 1;
    const accountRecent = readRecentRequestsForAccount(account.name, recentLimit);
    const last = accountRecent.at(-1);
    const live = options.json ? undefined : await fetchLiveUsage(account);

    return {
        accountName: account.name,
        provider: account.provider,
        tier: live?.tier ?? cachedBilling?.tier,
        summary: live?.summary ?? cachedBilling?.summary ?? "No billing data available",
        live,
        billing: billingSnapshot(cachedBilling),
        today,
        last,
        recent: options.recent ? accountRecent : undefined,
        storePaths: options.paths ? usageStorePaths() : undefined,
    };
}

export async function runUsageCommand(options: UsageCommandOptions): Promise<void> {
    const config = await loadConfig();
    const accounts = config.accounts.filter((item) => (options.account ? item.name === options.account : item.enabled));

    if (accounts.length === 0) {
        out.log.error("No matching accounts in config");
        return;
    }

    if (options.paths && !options.json) {
        const paths = usageStorePaths();
        out.log.info(`billing: ${paths.billing}`);
        out.log.info(`daily: ${paths.daily}`);
        out.log.info(`requests: ${paths.requests}`);
    }

    const providers = new Map<string, ProxyProvider>();
    const summaries: UsageCommandResult[] = [];

    for (const account of accounts) {
        summaries.push(await buildAccountUsage(account, providers, options));
    }

    if (options.json) {
        out.result({
            accounts: summaries,
            storePaths: options.paths ? usageStorePaths() : undefined,
        });
        return;
    }

    for (const summary of summaries) {
        const tier = summary.tier ? ` (${summary.tier})` : "";
        out.log.info(`${summary.accountName}: ${summary.summary}${tier}`);
        out.log.info(`  today: ${formatTodaySummary(summary.today)}`);

        if (summary.last) {
            out.log.info(`  last: ${formatLastRequest(summary.last)}`);
        }
    }
}
