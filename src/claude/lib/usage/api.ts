import logger from "@app/logger";
import { resolveAccountToken } from "@app/utils/claude/subscription-auth";
import type { AIAccountEntry } from "@app/utils/config/ai.types";

export type { AccountInfo, KeychainCredentials } from "@app/utils/claude/auth";

export class RetryableApiError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "RetryableApiError";
        this.statusCode = statusCode;
    }
}

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

export async function fetchUsage(
    accessToken: string,
    signal?: AbortSignal,
    accountHint?: string
): Promise<UsageResponse> {
    const tag = accountHint ? `[usage:${accountHint}]` : "[usage]";

    logger.debug(`${tag} fetching ${USAGE_URL}`);

    const res = await fetch(USAGE_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
        },
        signal,
    });

    if (res.status === 401 || res.status === 429) {
        const body = await res.text().catch(() => "");
        const label = res.status === 429 ? "rate-limited" : "auth failed";
        logger.warn(`${tag} ${res.status} ${label}: ${body.slice(0, 200)}`);
        throw new RetryableApiError(res.status, `Usage API ${res.status}: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error(`${tag} HTTP ${res.status}: ${body.slice(0, 200)}`);
        throw new Error(`Usage API ${res.status}: ${body.slice(0, 200)}`);
    }

    logger.debug(`${tag} OK (${res.status})`);
    return res.json() as Promise<UsageResponse>;
}

export async function fetchAllAccountsUsage(
    accountFilter?: string | string[],
    signal?: AbortSignal
): Promise<AccountUsage[]> {
    const { AIConfig } = await import("@app/utils/ai/AIConfig");
    const config = await AIConfig.load();
    let accounts = config.getAccountsByProvider("anthropic-sub");

    if (typeof accountFilter === "string") {
        accounts = accounts.filter((a) => a.name === accountFilter);
    } else if (Array.isArray(accountFilter)) {
        const filterSet = new Set(accountFilter);
        accounts = accounts.filter((a) => filterSet.has(a.name));
    }

    if (accounts.length === 0) {
        return [];
    }

    logger.debug(`[usage] polling ${accounts.length} account(s): ${accounts.map((a) => a.name).join(", ")}`);

    const results = await Promise.allSettled(
        accounts.map(async (account: AIAccountEntry) => {
            const tag = `[usage:${account.name}]`;

            const { token, refreshed: tokenRefreshed } = await resolveAccountToken(account.name, {
                staleAccessToken: account.tokens.accessToken,
            });

            if (tokenRefreshed) {
                logger.info(`${tag} token was refreshed before fetch`);
            }

            try {
                const usage = await fetchUsage(token, signal, account.name);
                return { accountName: account.name, label: account.label, usage } satisfies AccountUsage;
            } catch (err) {
                if (!(err instanceof RetryableApiError)) {
                    logger.error(`${tag} fetch failed: ${err instanceof Error ? err.message : err}`);
                    throw err;
                }

                // 401/429 — force-refresh token and retry once
                logger.warn(`${tag} got ${err.statusCode}, attempting force-refresh`);
                const { token: freshToken, refreshed } = await resolveAccountToken(account.name, {
                    staleAccessToken: token,
                    forceRefresh: true,
                });

                if (!refreshed) {
                    logger.warn(`${tag} force-refresh did not produce a new token, re-throwing ${err.statusCode}`);
                    throw err;
                }

                logger.info(`${tag} retrying with refreshed token`);
                const usage = await fetchUsage(freshToken, signal, account.name);
                return { accountName: account.name, label: account.label, usage } satisfies AccountUsage;
            }
        })
    );

    return results.map((r, i) => {
        if (r.status === "fulfilled") {
            return r.value;
        }

        logger.error(`[usage:${accounts[i].name}] final error: ${r.reason}`);
        return { accountName: accounts[i].name, label: accounts[i].label, error: String(r.reason) };
    });
}
