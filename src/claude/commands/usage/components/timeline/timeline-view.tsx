import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { VISIBLE_BUCKETS } from "@app/claude/lib/usage/constants";
import type { PollResult, TimelineZoom } from "../../types";
import { ZOOM_ORDER } from "../../types";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { ChartPanel } from "./chart-panel";

interface TimelineViewProps {
    db: UsageHistoryDb | null;
    results: PollResult | null;
    config: UsageDashboardConfig;
}

export function TimelineView({ db, results, config }: TimelineViewProps) {
    const { stdout } = useStdout();
    const termWidth = stdout?.columns ?? 80;
    const [zoom, setZoom] = useState<TimelineZoom>(
        (config.defaultTimelineZoom as TimelineZoom) || "30m"
    );
    const [selectedBucket, setSelectedBucket] = useState(0);
    const [showAllAccounts, setShowAllAccounts] = useState(false);

    const accounts = results?.accounts ?? [];
    const allBuckets = VISIBLE_BUCKETS.filter((b) => {
        return accounts.some((a) => a.usage && b in a.usage);
    });

    useInput((input, key) => {
        if (input === "+" || input === "=") {
            const idx = ZOOM_ORDER.indexOf(zoom);

            if (idx < ZOOM_ORDER.length - 1) {
                setZoom(ZOOM_ORDER[idx + 1]);
            }
        }

        if (input === "-") {
            const idx = ZOOM_ORDER.indexOf(zoom);

            if (idx > 0) {
                setZoom(ZOOM_ORDER[idx - 1]);
            }
        }

        if (key.upArrow) {
            setSelectedBucket((i) => (i > 0 ? i - 1 : allBuckets.length - 1));
        }

        if (key.downArrow) {
            setSelectedBucket((i) => (i < allBuckets.length - 1 ? i + 1 : 0));
        }

        if (input === "a") {
            setShowAllAccounts((v) => !v);
        }
    });

    if (!results || accounts.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"Loading timeline data..."}</Text>
            </Box>
        );
    }

    const currentBucket = allBuckets[selectedBucket] ?? allBuckets[0];

    if (!currentBucket) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No bucket data available."}</Text>
            </Box>
        );
    }

    const visibleAccounts = showAllAccounts ? accounts : accounts.slice(0, 1);

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
            {visibleAccounts.map((account) => (
                <ChartPanel
                    key={account.accountName}
                    db={db}
                    accountName={account.accountName}
                    bucket={currentBucket}
                    zoom={zoom}
                    width={termWidth - 4}
                />
            ))}
            <Box>
                <Text dimColor>
                    {"[↑/↓] Switch bucket  [+/-] Zoom  [a] All accounts"}
                </Text>
            </Box>
        </Box>
    );
}
