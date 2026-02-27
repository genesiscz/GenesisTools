import { useMemo } from "react";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import {
    calculateRollingRates,
    projectTimeToLimit,
    type RollingRates,
} from "@app/claude/lib/usage/rate-math";

interface RateResult {
    rates: RollingRates;
    projections: Record<string, number | null>;
    currentUtilization: number;
}

export function useRateCalculator(
    db: UsageHistoryDb | null,
    accountName: string,
    bucket: string,
    currentUtilization: number
): RateResult {
    return useMemo(() => {
        if (!db) {
            return {
                rates: { "1min": null, "5min": null, "10min": null, "30min": null },
                projections: {},
                currentUtilization,
            };
        }

        const snapshots = db.getSnapshots(accountName, bucket, 30);
        const data = snapshots.map((s) => ({
            timestamp: s.timestamp,
            value: s.utilization,
        }));

        const rates = calculateRollingRates(data, new Date());

        const projections: Record<string, number | null> = {};

        for (const [window, rate] of Object.entries(rates)) {
            if (rate !== null) {
                projections[window] = projectTimeToLimit(currentUtilization, rate);
            } else {
                projections[window] = null;
            }
        }

        return { rates, projections, currentUtilization };
    }, [db, accountName, bucket, currentUtilization]);
}
