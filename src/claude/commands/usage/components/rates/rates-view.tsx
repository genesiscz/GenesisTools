import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import type { PollResult } from "../../types";
import { useRateCalculator } from "../../hooks/use-rate-calculator";
import { RateTable } from "./rate-table";
import { RateSparkline } from "./rate-sparkline";

interface RatesViewProps {
    db: UsageHistoryDb | null;
    results: PollResult | null;
}

const VISIBLE_BUCKETS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"];
const BUCKET_LABELS: Record<string, string> = {
    five_hour: "Session (5h)",
    seven_day: "Weekly (all)",
    seven_day_opus: "Weekly (Opus)",
    seven_day_sonnet: "Weekly (Sonnet)",
    seven_day_oauth_apps: "Weekly (OAuth)",
};

function RateBucketView({
    db,
    accountName,
    bucket,
    utilization,
}: {
    db: UsageHistoryDb | null;
    accountName: string;
    bucket: string;
    utilization: number;
}) {
    const { rates, projections, currentUtilization } = useRateCalculator(
        db,
        accountName,
        bucket,
        utilization
    );
    const label = BUCKET_LABELS[bucket] ?? bucket;

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>
                {`${accountName} — ${label}`}
                <Text dimColor>{`  Current: ${Math.round(currentUtilization)}%`}</Text>
            </Text>
            <Box marginLeft={2}>
                <Text>{"Rate trend: "}</Text>
                <RateSparkline db={db} accountName={accountName} bucket={bucket} />
            </Box>
            <Box marginLeft={2} marginTop={1}>
                <RateTable
                    rates={rates}
                    projections={projections}
                    currentUtilization={currentUtilization}
                />
            </Box>
        </Box>
    );
}

export function RatesView({ db, results }: RatesViewProps) {
    const [selectedAccount, setSelectedAccount] = useState(0);
    const [selectedBucket, setSelectedBucket] = useState(0);

    const accounts = results?.accounts ?? [];

    useInput((input, key) => {
        if (key.upArrow) {
            setSelectedAccount((i) => (i > 0 ? i - 1 : accounts.length - 1));
        }

        if (key.downArrow) {
            setSelectedAccount((i) => (i < accounts.length - 1 ? i + 1 : 0));
        }

        if (input === "b") {
            setSelectedBucket((i) => (i < VISIBLE_BUCKETS.length - 1 ? i + 1 : 0));
        }
    });

    if (!results || accounts.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"Loading rate data..."}</Text>
            </Box>
        );
    }

    const account = accounts[selectedAccount];

    if (!account || !account.usage) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No usage data available."}</Text>
            </Box>
        );
    }

    const activeBuckets = VISIBLE_BUCKETS.filter(
        (b) => account.usage && b in account.usage && account.usage[b]
    );
    const currentBucket = activeBuckets[selectedBucket % activeBuckets.length];

    if (!currentBucket) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No bucket data."}</Text>
            </Box>
        );
    }

    const bucketData = account.usage[currentBucket];

    if (!bucketData) {
        return null;
    }

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            <RateBucketView
                db={db}
                accountName={account.accountName}
                bucket={currentBucket}
                utilization={bucketData.utilization}
            />
            <Box>
                <Text dimColor>
                    {"[↑/↓] Switch account  [b] Switch bucket"}
                </Text>
            </Box>
        </Box>
    );
}
