import type { AccountUsage, UsageBucket } from "@app/claude/lib/usage/api";
import { BUCKET_INK_COLORS, BUCKET_LABELS, VISIBLE_BUCKETS } from "@app/claude/lib/usage/constants";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { calculateRollingRates, formatDuration, projectTimeToLimit } from "@app/claude/lib/usage/rate-math";
import { Box, Text } from "ink";
import { useMemo } from "react";
import type { PollResult } from "../../types";
import { RateSparkline } from "./rate-sparkline";

interface RatesViewProps {
    db: UsageHistoryDb | null;
    results: PollResult | null;
}

interface BucketRateInfo {
    utilization: number;
    rate5min: number | null;
    projMinutes: number | null;
}

function computeBucketRate(
    db: UsageHistoryDb | null,
    accountName: string,
    bucket: string,
    utilization: number
): BucketRateInfo {
    if (!db) {
        return { utilization, rate5min: null, projMinutes: null };
    }

    const snapshots = db.getSnapshots(accountName, bucket, 30);
    const data = snapshots.map((s) => ({
        timestamp: s.timestamp,
        value: s.utilization,
    }));

    const rates = calculateRollingRates(data, new Date());
    const rate5min = rates["5min"];
    const projMinutes = rate5min !== null ? projectTimeToLimit(utilization, rate5min) : null;

    return { utilization, rate5min, projMinutes };
}

function formatRate(rate: number | null): string {
    if (rate === null) {
        return "—";
    }

    const sign = rate >= 0 ? "+" : "";
    return `${sign}${rate.toFixed(2)}/m`;
}

function formatProj(minutes: number | null): string {
    if (minutes === null) {
        return "—";
    }

    if (minutes === 0) {
        return "at limit";
    }

    return formatDuration(minutes);
}

function AccountRatesRow({
    db,
    account,
    activeBuckets,
}: {
    db: UsageHistoryDb | null;
    account: AccountUsage;
    activeBuckets: string[];
}) {
    const bucketRates = useMemo(() => {
        const rates: Record<string, BucketRateInfo> = {};

        for (const bucket of activeBuckets) {
            const bucketData = account.usage?.[bucket] as UsageBucket | undefined;

            if (bucketData) {
                rates[bucket] = computeBucketRate(db, account.accountName, bucket, bucketData.utilization);
            }
        }

        return rates;
    }, [db, account, activeBuckets]);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>{`── ${account.accountName} ${"─".repeat(Math.max(0, 40 - account.accountName.length))}`}</Text>
            {activeBuckets.map((bucket) => {
                const info = bucketRates[bucket];

                if (!info) {
                    return null;
                }

                const label = (BUCKET_LABELS[bucket] ?? bucket).padEnd(16);
                const color = BUCKET_INK_COLORS[bucket] ?? "white";

                return (
                    <Box key={bucket}>
                        <Text color={color}>{label}</Text>
                        <Text bold>{`${Math.round(info.utilization)}%`.padEnd(7)}</Text>
                        <Text color={info.rate5min !== null && info.rate5min > 0 ? "yellow" : "green"}>
                            {formatRate(info.rate5min).padEnd(10)}
                        </Text>
                        <Text dimColor>{formatProj(info.projMinutes).padEnd(12)}</Text>
                        <RateSparkline db={db} accountName={account.accountName} bucket={bucket} />
                    </Box>
                );
            })}
        </Box>
    );
}

export function RatesView({ db, results }: RatesViewProps) {
    const accounts = results?.accounts ?? [];

    if (!results || accounts.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"Loading rate data..."}</Text>
            </Box>
        );
    }

    const activeBuckets = VISIBLE_BUCKETS.filter((b) => {
        return accounts.some((a) => a.usage && b in a.usage && a.usage[b]);
    });

    if (activeBuckets.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No bucket data."}</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <Box>
                <Text bold>
                    {`${"Bucket".padEnd(16)}${"Use%".padEnd(7)}${"Rate/5m".padEnd(10)}${"Proj limit".padEnd(12)}Trend`}
                </Text>
            </Box>
            <Text dimColor>{"─".repeat(60)}</Text>
            {accounts.map((account) => {
                if (!account.usage) {
                    return null;
                }

                return (
                    <AccountRatesRow
                        key={account.accountName}
                        db={db}
                        account={account}
                        activeBuckets={activeBuckets}
                    />
                );
            })}
        </Box>
    );
}
