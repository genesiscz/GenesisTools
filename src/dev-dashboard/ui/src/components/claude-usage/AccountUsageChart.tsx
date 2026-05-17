import type { MultiBucketHistoryResult } from "@app/dev-dashboard/lib/claude-usage/types";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { formatAccountTitle } from "./account-title";
import { UsageChart } from "./UsageChart";

// 5-hour, weekly, and Sonnet weekly limits — the three lines per account.
const BUCKETS = "five_hour,seven_day,seven_day_sonnet";

interface AccountUsageChartProps {
    accountName: string;
    /** Subscription tier label (e.g. "max 20x"); shown next to the name. */
    label?: string;
    /** Current poll error for this account, if any (from /api/claude/usage). */
    accountError?: string;
    rangeMinutes: number;
}

// One independent query per account so each chart shows its own loader and
// renders as soon as its data arrives — no waiting on the slowest account.
export function AccountUsageChart({ accountName, label, accountError, rangeMinutes }: AccountUsageChartProps) {
    const query = useQuery({
        queryKey: ["claude", "usage", "history", accountName, rangeMinutes],
        queryFn: () =>
            fetchJson<MultiBucketHistoryResult>(
                `/api/claude/usage/history?account=${encodeURIComponent(accountName)}&buckets=${BUCKETS}&minutes=${rangeMinutes}`
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
            rangeMinutes={rangeMinutes}
            loading={query.isLoading}
            hint={hint}
        />
    );
}
