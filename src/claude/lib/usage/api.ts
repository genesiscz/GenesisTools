import type { AIAccountEntry } from "@app/utils/config/ai.types";
import { resolveAccountToken } from "@app/utils/claude/subscription-auth";

export type { AccountInfo, KeychainCredentials } from "@app/utils/claude/auth";

export class RateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RateLimitError";
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

export async function fetchUsage(accessToken: string, signal?: AbortSignal): Promise<UsageResponse> {
    const res = await fetch(USAGE_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
        },
        signal,
    });

    if (res.status === 429) {
        const body = await res.text().catch(() => "");
        throw new RateLimitError(`Usage API 429: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Usage API ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json() as Promise<UsageResponse>;
}

export async function fetchAllAccountsUsage(
    accountFilter?: string | string[],
    signal?: AbortSignal,
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

    const results = await Promise.allSettled(
        accounts.map(async (account: AIAccountEntry) => {
            const { token } = await resolveAccountToken(account.name, {
                staleAccessToken: account.tokens.accessToken,
            });

            try {
                const usage = await fetchUsage(token, signal);
                return { accountName: account.name, label: account.label, usage } satisfies AccountUsage;
            } catch (err) {
                if (!(err instanceof RateLimitError)) {
                    throw err;
                }

                // 429 — force-refresh token to get fresh rate limit window
                const { token: freshToken, refreshed } = await resolveAccountToken(account.name, {
                    staleAccessToken: account.tokens.accessToken,
                    forceRefresh: true,
                });

                if (!refreshed) {
                    throw err;
                }

                const usage = await fetchUsage(freshToken, signal);
                return { accountName: account.name, label: account.label, usage } satisfies AccountUsage;
            }
        }),
    );

    return results.map((r, i) =>
        r.status === "fulfilled"
            ? r.value
            : { accountName: accounts[i].name, label: accounts[i].label, error: String(r.reason) },
    );
}
