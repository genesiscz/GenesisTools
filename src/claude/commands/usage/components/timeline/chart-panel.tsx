import { BUCKET_COLORS, BUCKET_INK_COLORS, BUCKET_LABELS } from "@app/claude/lib/usage/constants";
import type { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { Box, Text } from "ink";
import { useMemo } from "react";
import type { TimelineZoom } from "../../types";
import { ZOOM_MINUTES } from "../../types";
import { CHART_MODE_LABELS, type ChartMode, type ChartSeries, renderChart } from "./chart-renderers";

interface ChartPanelProps {
    db: UsageHistoryDb | null;
    accountName: string;
    buckets: string[];
    zoom: TimelineZoom;
    width: number;
    chartMode: ChartMode;
}

interface TimedValue {
    timestamp: string;
    value: number;
}

/**
 * Time-aligned resampling: maps each snapshot to its correct column
 * position based on timestamp within the zoom window, then forward-fills
 * gaps so the line extends from the earliest data to "now".
 */
function resampleTimeAligned(timedValues: TimedValue[], minutes: number, targetWidth: number): number[] {
    if (timedValues.length === 0) {
        return [];
    }

    const now = Date.now();
    const startTime = now - minutes * 60_000;
    const timeSpan = now - startTime;
    const result: (number | null)[] = new Array(targetWidth).fill(null);

    // Map each snapshot to its column based on timestamp position
    for (const tv of timedValues) {
        const t = new Date(tv.timestamp).getTime();
        const ratio = (t - startTime) / timeSpan;
        const col = Math.min(Math.max(0, Math.floor(ratio * targetWidth)), targetWidth - 1);

        // If multiple snapshots map to the same column, keep the latest
        result[col] = tv.value;
    }

    // Forward-fill: extend last known value through gaps and to "now"
    // First, backward-fill positions before the first data point
    let firstKnown: number | null = null;

    for (const v of result) {
        if (v !== null) {
            firstKnown = v;
            break;
        }
    }

    if (firstKnown !== null) {
        for (let i = 0; i < targetWidth; i++) {
            if (result[i] !== null) {
                break;
            }

            result[i] = firstKnown;
        }
    }

    // Then forward-fill from left to right (fills gaps + extends to "now")
    let lastKnown: number | null = null;

    for (let i = 0; i < targetWidth; i++) {
        if (result[i] !== null) {
            lastKnown = result[i];
        } else if (lastKnown !== null) {
            result[i] = lastKnown;
        }
    }

    return result.map((v) => v ?? 0);
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
            let snapshots = db.getSnapshots(accountName, bucket, minutes);

            // Fill-forward: if no data in zoom window, use latest known value
            if (snapshots.length === 0) {
                const latest = db.getLatest(accountName, bucket);

                if (latest) {
                    snapshots = [latest];
                }
            }

            if (snapshots.length > 0) {
                const timedValues = snapshots.map((s) => ({
                    timestamp: s.timestamp,
                    value: Math.max(0, Math.min(s.utilization, 100)),
                }));
                series.push({
                    label: BUCKET_LABELS[bucket] ?? bucket,
                    values: resampleTimeAligned(timedValues, minutes, chartWidth),
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
                <Text dimColor>{"  No data yet. Snapshots will appear after a few polls."}</Text>
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
