import { Box, Text } from "ink";
import { useMemo } from "react";
import asciichart from "asciichart";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import {
    BUCKET_LABELS,
    BUCKET_COLORS,
    BUCKET_INK_COLORS,
} from "@app/claude/lib/usage/constants";
import type { TimelineZoom } from "../../types";
import { ZOOM_MINUTES } from "../../types";

interface ChartPanelProps {
    db: UsageHistoryDb | null;
    accountName: string;
    buckets: string[];
    zoom: TimelineZoom;
    width: number;
}

function resample(values: number[], targetWidth: number): number[] {
    if (values.length === 0) {
        return [];
    }

    if (values.length > targetWidth) {
        const resampled: number[] = [];
        const step = values.length / targetWidth;

        for (let i = 0; i < targetWidth; i++) {
            const idx = Math.min(Math.floor(i * step), values.length - 1);
            resampled.push(values[idx]);
        }

        return resampled;
    }

    if (values.length < 3) {
        const resampled: number[] = [];
        const fillCount = Math.max(targetWidth, 10);

        for (let i = 0; i < fillCount; i++) {
            const ratio = i / (fillCount - 1);
            const srcIdx = Math.min(
                Math.floor(ratio * (values.length - 1)),
                values.length - 1
            );
            resampled.push(values[srcIdx]);
        }

        return resampled;
    }

    return values;
}

function formatTimeLabel(date: Date): string {
    return date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
    });
}

function buildTimeAxis(minutes: number, plotWidth: number): string {
    const yAxisPad = 7;
    const axisWidth = plotWidth - yAxisPad;

    if (axisWidth < 20) {
        return "";
    }

    const now = new Date();
    const startTime = new Date(now.getTime() - minutes * 60_000);

    const startLabel = formatTimeLabel(startTime);
    const endLabel = formatTimeLabel(now);

    const gap = axisWidth - startLabel.length - endLabel.length;

    if (gap < 4) {
        return " ".repeat(yAxisPad) + startLabel + " ".repeat(Math.max(1, gap)) + endLabel;
    }

    const midTime = new Date(startTime.getTime() + (now.getTime() - startTime.getTime()) / 2);
    const midLabel = formatTimeLabel(midTime);

    const leftGap = Math.floor((gap - midLabel.length) / 2);
    const rightGap = gap - midLabel.length - leftGap;

    return (
        " ".repeat(yAxisPad) +
        startLabel +
        "─".repeat(Math.max(1, leftGap)) +
        midLabel +
        "─".repeat(Math.max(1, rightGap)) +
        endLabel
    );
}

export function ChartPanel({ db, accountName, buckets, zoom, width }: ChartPanelProps) {
    const chartWidth = Math.max(20, width - 12);
    const minutes = ZOOM_MINUTES[zoom];

    const { chartOutput, activeBuckets, timeAxis } = useMemo(() => {
        if (!db) {
            return { chartOutput: null, activeBuckets: [] as string[], timeAxis: "" };
        }

        const seriesMap = new Map<string, Array<{ utilization: number }>>();
        const active: string[] = [];

        for (const bucket of buckets) {
            const snapshots = db.getSnapshots(accountName, bucket, minutes);

            if (snapshots.length > 0) {
                seriesMap.set(bucket, snapshots);
                active.push(bucket);
            }
        }

        if (active.length === 0) {
            return { chartOutput: null, activeBuckets: [] as string[], timeAxis: "" };
        }

        const allSeries: number[][] = [];
        const colors: string[] = [];

        for (const bucket of active) {
            const snapshots = seriesMap.get(bucket)!;
            const values = snapshots.map((s) => Math.max(0, Math.min(s.utilization, 100)));
            allSeries.push(resample(values, chartWidth));
            colors.push(BUCKET_COLORS[bucket] ?? "\x1b[37m");
        }

        const axis = buildTimeAxis(minutes, chartWidth);

        try {
            const chart = asciichart.plot(allSeries.length === 1 ? allSeries[0] : allSeries, {
                height: 8,
                width: chartWidth,
                min: 0,
                max: 100,
                colors: allSeries.length > 1 ? colors : undefined,
                format: (v: number) => `${Math.round(v).toString().padStart(3)}%`,
            });

            return { chartOutput: chart, activeBuckets: active, timeAxis: axis };
        } catch {
            return { chartOutput: null, activeBuckets: active, timeAxis: axis };
        }
    }, [db, accountName, buckets, minutes, chartWidth]);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>
                {accountName}
                <Text dimColor>{`  Last ${zoom}`}</Text>
            </Text>
            {chartOutput ? (
                <Box flexDirection="column">
                    <Text>{chartOutput}</Text>
                    {timeAxis && <Text dimColor>{timeAxis}</Text>}
                </Box>
            ) : (
                <Text dimColor>
                    {"  No data yet. Snapshots will appear after a few polls."}
                </Text>
            )}
            {activeBuckets.length > 0 && (
                <Box gap={2}>
                    {activeBuckets.map((b) => (
                        <Text key={b} color={BUCKET_INK_COLORS[b] ?? "white"}>
                            {`■ ${BUCKET_LABELS[b] ?? b}`}
                        </Text>
                    ))}
                </Box>
            )}
        </Box>
    );
}
