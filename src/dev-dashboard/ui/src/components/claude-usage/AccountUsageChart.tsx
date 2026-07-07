import type { AccountUsage } from "@app/claude/lib/usage/api";
import { normalizeLimits } from "@app/claude/lib/usage/limits";
import type { MultiBucketHistoryResult } from "@app/dev-dashboard/lib/claude-usage/types";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchJson } from "@/lib/api";
import { formatAccountTitle } from "./account-title";
import { UsageChart } from "./UsageChart";

interface AccountUsageChartProps {
    account: AccountUsage;
    rangeMinutes: number;
    rangeEndMs: number;
}

const FALLBACK_BUCKETS = ["five_hour", "seven_day"];

// One independent query per account so each chart shows its own loader and
// renders as soon as its data arrives — no waiting on the slowest account.
export function AccountUsageChart({ account, rangeMinutes, rangeEndMs }: AccountUsageChartProps) {
    const { accountName, label, error: accountError } = account;

    const { bucketKeys, scopeModelByBucket } = useMemo(() => {
        if (!account.usage) {
            return { bucketKeys: FALLBACK_BUCKETS, scopeModelByBucket: {} as Record<string, string | null> };
        }

        const limits = normalizeLimits(account.usage);
        const keys: string[] = [];
        const map: Record<string, string | null> = {};

        for (const limit of limits) {
            if (map[limit.bucket] !== undefined) {
                continue;
            }

            keys.push(limit.bucket);
            map[limit.bucket] = limit.scope_model;
        }

        if (keys.length === 0) {
            return { bucketKeys: FALLBACK_BUCKETS, scopeModelByBucket: {} as Record<string, string | null> };
        }

        return { bucketKeys: keys, scopeModelByBucket: map };
    }, [account.usage]);

    const bucketsParam = bucketKeys.map((b) => encodeURIComponent(b)).join(",");

    const query = useQuery({
        queryKey: ["claude", "usage", "history", accountName, rangeMinutes, bucketsParam],
        queryFn: () =>
            fetchJson<MultiBucketHistoryResult>(
                `/api/claude/usage/history?account=${encodeURIComponent(accountName)}&buckets=${bucketsParam}&minutes=${rangeMinutes}`
            ),
        refetchInterval: 30000,
    });

    // A failed account poll is not a daemon problem — don't show the generic
    // "run daemon install" hint (the account card already shows the real
    // error). Only fall back to the daemon hint for a healthy account that
    // simply has no history yet.
    const hint = accountError ? "Usage poll failed for this account — see the card above." : query.data?.hint;

    return (
        <UsageChart
            title={formatAccountTitle(accountName, label)}
            series={query.data?.series ?? []}
            scopeModelByBucket={scopeModelByBucket}
            rangeMinutes={rangeMinutes}
            rangeEndMs={rangeEndMs}
            loading={query.isLoading}
            hint={hint}
        />
    );
}
