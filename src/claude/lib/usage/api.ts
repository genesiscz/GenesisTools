import type { AccountConfig } from "@app/claude/lib/config";
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
    accounts: Record<string, AccountConfig>,
    signal?: AbortSignal,
): Promise<AccountUsage[]> {
    const entries = Object.entries(accounts);

    if (entries.length === 0) {
        return [];
    }

    const results = await Promise.allSettled(
        entries.map(async ([name, account]) => {
            const { token } = await resolveAccountToken(name, {
                staleAccessToken: account.accessToken,
            });

            try {
                const usage = await fetchUsage(token, signal);
                return { accountName: name, label: account.label, usage } satisfies AccountUsage;
            } catch (err) {
                if (!(err instanceof RateLimitError)) {
                    throw err;
                }

                // 429 — force-refresh token to get fresh rate limit window
                const { token: freshToken, refreshed } = await resolveAccountToken(name, {
                    staleAccessToken: account.accessToken,
                    forceRefresh: true,
                });

                if (!refreshed) {
                    throw err;
                }

                const usage = await fetchUsage(freshToken, signal);
                return { accountName: name, label: account.label, usage } satisfies AccountUsage;
            }
        }),
    );

    return results.map((r, i) =>
        r.status === "fulfilled"
            ? r.value
            : { accountName: entries[i][0], label: entries[i][1].label, error: String(r.reason) },
    );
}
