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
    const [showAllAccounts, setShowAllAccounts] = useState(true);

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

    if (allBuckets.length === 0) {
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
                    buckets={allBuckets}
                    zoom={zoom}
                    width={termWidth - 4}
                />
            ))}
            <Box>
                <Text dimColor>
                    {"[+/-] Zoom  [a] Toggle all accounts"}
                </Text>
            </Box>
        </Box>
    );
}
