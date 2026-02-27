import { Box, Text } from "ink";
import { useMemo } from "react";
import asciichart from "asciichart";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { BUCKET_LABELS } from "@app/claude/lib/usage/constants";
import type { TimelineZoom } from "../../types";
import { ZOOM_MINUTES } from "../../types";

interface ChartPanelProps {
    db: UsageHistoryDb | null;
    accountName: string;
    bucket: string;
    zoom: TimelineZoom;
    width: number;
}

export function ChartPanel({ db, accountName, bucket, zoom, width }: ChartPanelProps) {
    const chartWidth = Math.max(20, width - 12);
    const minutes = ZOOM_MINUTES[zoom];
    const label = BUCKET_LABELS[bucket] ?? bucket;

    const chartOutput = useMemo(() => {
        if (!db) {
            return null;
        }

        const snapshots = db.getSnapshots(accountName, bucket, minutes);

        if (snapshots.length === 0) {
            return null;
        }

        // Resample to fit chart width
        const values = snapshots.map((s) => s.utilization);
        let resampled: number[];

        if (values.length > chartWidth) {
            resampled = [];
            const step = values.length / chartWidth;

            for (let i = 0; i < chartWidth; i++) {
                const idx = Math.min(Math.floor(i * step), values.length - 1);
                resampled.push(values[idx]);
            }
        } else if (values.length < 3) {
            // Fill gaps for flat lines (write-on-change means few data points)
            resampled = [];
            const fillCount = Math.max(chartWidth, 10);

            for (let i = 0; i < fillCount; i++) {
                const ratio = i / (fillCount - 1);
                const srcIdx = Math.min(Math.floor(ratio * (values.length - 1)), values.length - 1);
                resampled.push(values[srcIdx]);
            }
        } else {
            resampled = values;
        }

        try {
            return asciichart.plot(resampled, {
                height: 8,
                width: chartWidth,
                min: 0,
                max: 100,
                format: (v: number) => `${Math.round(v).toString().padStart(3)}%`,
            });
        } catch {
            return null;
        }
    }, [db, accountName, bucket, minutes, chartWidth]);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>
                {`${label} — ${accountName}`}
                <Text dimColor>{`  Last ${zoom}`}</Text>
            </Text>
            {chartOutput ? (
                <Text>{chartOutput}</Text>
            ) : (
                <Text dimColor>{"  No data yet. Snapshots will appear after a few polls."}</Text>
            )}
        </Box>
    );
}
