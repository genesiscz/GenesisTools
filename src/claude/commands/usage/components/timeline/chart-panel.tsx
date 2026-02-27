import { Box, Text } from "ink";
import { useMemo } from "react";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import {
    BUCKET_LABELS,
    BUCKET_COLORS,
    BUCKET_INK_COLORS,
} from "@app/claude/lib/usage/constants";
import type { TimelineZoom } from "../../types";
import { ZOOM_MINUTES } from "../../types";
import { renderChart, CHART_MODE_LABELS, type ChartMode, type ChartSeries } from "./chart-renderers";

interface ChartPanelProps {
    db: UsageHistoryDb | null;
    accountName: string;
    buckets: string[];
    zoom: TimelineZoom;
    width: number;
    chartMode: ChartMode;
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

export function ChartPanel({ db, accountName, buckets, zoom, width, chartMode }: ChartPanelProps) {
    const chartWidth = Math.max(20, width - 12);
    const minutes = ZOOM_MINUTES[zoom];

    const { chartOutput, activeBuckets, timeAxis } = useMemo(() => {
        if (!db) {
            return { chartOutput: null, activeBuckets: [] as string[], timeAxis: "" };
        }

        const series: ChartSeries[] = [];

        for (const bucket of buckets) {
            const snapshots = db.getSnapshots(accountName, bucket, minutes);

            if (snapshots.length > 0) {
                const values = snapshots.map((s) => Math.max(0, Math.min(s.utilization, 100)));
                series.push({
                    label: BUCKET_LABELS[bucket] ?? bucket,
                    values: resample(values, chartWidth),
                    color: BUCKET_COLORS[bucket] ?? "\x1b[37m",
                    inkColor: BUCKET_INK_COLORS[bucket] ?? "white",
                });
            }
        }

        if (series.length === 0) {
            return { chartOutput: null, activeBuckets: [] as string[], timeAxis: "" };
        }

        const maxValue = Math.max(...series.flatMap((s) => s.values));
        const axis = buildTimeAxis(minutes, chartWidth);
        const chart = renderChart(chartMode, { series, maxValue, chartWidth });
        const active = series.map((s) => buckets.find((b) => (BUCKET_LABELS[b] ?? b) === s.label) ?? s.label);

        return { chartOutput: chart, activeBuckets: active, timeAxis: axis };
    }, [db, accountName, buckets, minutes, chartWidth, chartMode]);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>
                {accountName}
                <Text dimColor>{`  Last ${zoom}  (${CHART_MODE_LABELS[chartMode]})`}</Text>
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
