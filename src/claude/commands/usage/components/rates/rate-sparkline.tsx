import { Text } from "ink";
import { useMemo } from "react";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";

interface RateSparklineProps {
    db: UsageHistoryDb | null;
    accountName: string;
    bucket: string;
}

const SPARK_CHARS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

export function RateSparkline({ db, accountName, bucket }: RateSparklineProps) {
    const sparkline = useMemo(() => {
        if (!db) {
            return null;
        }

        const snapshots = db.getSnapshots(accountName, bucket, 10);

        if (snapshots.length < 2) {
            return null;
        }

        const rates: number[] = [];

        for (let i = 1; i < snapshots.length; i++) {
            const prev = snapshots[i - 1];
            const curr = snapshots[i];
            const diffMs = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();

            if (diffMs > 0) {
                rates.push((curr.utilization - prev.utilization) / (diffMs / 60000));
            }
        }

        if (rates.length === 0) {
            return null;
        }

        const min = Math.min(...rates);
        const max = Math.max(...rates);
        const range = max - min || 1;

        return rates
            .map((r) => {
                const idx = Math.min(
                    Math.floor(((r - min) / range) * (SPARK_CHARS.length - 1)),
                    SPARK_CHARS.length - 1
                );
                return SPARK_CHARS[idx];
            })
            .join("");
    }, [db, accountName, bucket]);

    if (!sparkline) {
        return <Text dimColor>{"—"}</Text>;
    }

    return <Text color="cyan">{sparkline}</Text>;
}
