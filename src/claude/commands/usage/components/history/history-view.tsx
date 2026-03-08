import type { UsageHistoryDb, UsageSnapshot } from "@app/claude/lib/usage/history-db";
import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import { useScroll } from "../../hooks/use-scroll";

// Module-level: survives component unmount/remount (tab switches)
let _savedHistoryOffset = 0;

interface HistoryViewProps {
    db: UsageHistoryDb | null;
    dbVersion: number;
}

const BUCKET_SHORT_LABELS: Record<string, string> = {
    five_hour: "session",
    seven_day: "weekly",
    seven_day_opus: "opus",
    seven_day_sonnet: "sonnet",
    seven_day_oauth_apps: "oauth",
};

function formatTimestamp(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatTimePerPercent(deltaMs: number, deltaPct: number): string {
    if (deltaPct <= 0) {
        return "—";
    }

    const msPerPct = deltaMs / deltaPct;
    const totalSec = Math.round(msPerPct / 1000);

    if (totalSec < 60) {
        return `${totalSec}s`;
    }

    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;

    if (min < 60) {
        return sec > 0 ? `${min}m${sec}s` : `${min}m`;
    }

    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

interface SnapshotWithDelta extends UsageSnapshot {
    delta: number | null;
    timePerPct: string | null;
}

function computeDeltas(snapshots: UsageSnapshot[]): SnapshotWithDelta[] {
    return snapshots.map((s, i) => {
        if (i === 0) {
            return { ...s, delta: null, timePerPct: null };
        }

        const prev = snapshots[i - 1];
        const delta = s.utilization - prev.utilization;
        const diffMs = new Date(s.timestamp).getTime() - new Date(prev.timestamp).getTime();

        let timePerPct: string | null = null;

        if (diffMs > 0 && delta > 0) {
            timePerPct = formatTimePerPercent(diffMs, delta);
        }

        return { ...s, delta, timePerPct };
    });
}

export function HistoryView({ db, dbVersion }: HistoryViewProps) {
    const { stdout } = useStdout();
    const termHeight = stdout?.rows ?? 24;

    const [layout, setLayout] = useState<"stacked" | "side-by-side">("stacked");
    const [timeRange, setTimeRange] = useState(60); // minutes

    // biome-ignore lint/correctness/useExhaustiveDependencies: dbVersion is an intentional cache-busting dep — db ref is stable but DB contents change on each poll
    const allData = useMemo(() => {
        if (!db) {
            return new Map<string, SnapshotWithDelta[]>();
        }

        const pairs = db.getAllAccountBuckets();
        const result = new Map<string, SnapshotWithDelta[]>();

        for (const { accountName, bucket } of pairs) {
            const snapshots = db.getSnapshots(accountName, bucket, timeRange);
            const key = `${accountName}:${bucket}`;
            result.set(key, computeDeltas(snapshots).reverse());
        }

        return result;
    }, [db, timeRange, dbVersion]);

    const allRows = useMemo(() => {
        const rows: Array<{ key: string; data: SnapshotWithDelta }> = [];

        for (const [key, snapshots] of allData) {
            for (const s of snapshots) {
                rows.push({ key, data: s });
            }
        }

        return rows;
    }, [allData]);

    // Chrome: TabBar(1) + StatusBar(3) + paddingY(2) + hint(1) + colHeader(1) = 8
    // Account separator headers: first = 1 line, subsequent = 2 lines (marginTop=1)
    const uniqueAccounts = new Set(Array.from(allData.keys()).map((k) => k.split(":")[0])).size;
    const separatorLines = uniqueAccounts > 0 ? 1 + (uniqueAccounts - 1) * 2 : 0;
    const pageSize = Math.max(3, termHeight - 8 - separatorLines);

    const { offset, setOffset } = useScroll({
        totalItems: allRows.length,
        pageSize,
        enabled: true,
        initialOffset: _savedHistoryOffset,
    });

    // Persist offset so it survives tab switches (component unmount/remount)
    useEffect(() => {
        _savedHistoryOffset = offset;
    }, [offset]);

    // When new data arrives and current offset is beyond new total, clamp it
    useEffect(() => {
        const max = Math.max(0, allRows.length - pageSize);

        if (offset > max) {
            setOffset(max);
        }
    }, [allRows.length, pageSize, offset, setOffset]);

    useInput((input) => {
        if (input === "l") {
            setLayout((l) => (l === "stacked" ? "side-by-side" : "stacked"));
        }

        if (input === "f") {
            setTimeRange((t) => {
                if (t === 60) {
                    return 360;
                }
                if (t === 360) {
                    return 1440;
                }
                if (t === 1440) {
                    return 10080;
                }
                return 60;
            });
        }
    });

    if (!db || allData.size === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No history data yet. Data will appear after a few polls."}</Text>
            </Box>
        );
    }

    const rangeLabel =
        timeRange <= 60 ? `${timeRange}m` : timeRange <= 1440 ? `${timeRange / 60}h` : `${timeRange / 1440}d`;

    // Cap history view height so Ink never renders beyond the terminal
    const maxHeight = Math.max(8, termHeight - 4);

    if (layout === "stacked") {
        const visibleRows = allRows.slice(offset, offset + pageSize);

        return (
            <Box flexDirection="column" paddingX={1} paddingY={1} height={maxHeight} overflow="hidden">
                <Text
                    dimColor
                >{`Showing last ${rangeLabel}  [f] cycle range  [l] layout  [j/k] scroll  (${allRows.length > 0 ? offset + 1 : 0}-${Math.min(offset + pageSize, allRows.length)} of ${allRows.length})`}</Text>
                <Box>
                    <Text bold>
                        {`${"Time".padEnd(10)}${"Bucket".padEnd(10)}${"Util %".padEnd(10)}${"Δ%".padEnd(8)}Speed / 1%`}
                    </Text>
                </Box>
                {visibleRows.map((row, i) => {
                    const showHeader = i === 0 || row.key !== visibleRows[i - 1].key;
                    const accountName = row.data.accountName;
                    const bucketLabel = BUCKET_SHORT_LABELS[row.data.bucket] ?? row.data.bucket;
                    const s = row.data;

                    return (
                        <Box key={`${row.key}-${s.timestamp}-${i}`} flexDirection="column">
                            {showHeader && (
                                <Box marginTop={i > 0 ? 1 : 0}>
                                    <Text bold>{`── ${accountName} ${"─".repeat(40)}`}</Text>
                                </Box>
                            )}
                            <Box>
                                <Text dimColor>{formatTimestamp(s.timestamp).padEnd(10)}</Text>
                                <Text>{bucketLabel.padEnd(10)}</Text>
                                <Text>{`${s.utilization.toFixed(1)}%`.padEnd(10)}</Text>
                                <Text color={s.delta !== null && s.delta > 0 ? "yellow" : "green"}>
                                    {s.delta !== null
                                        ? `${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(1)}`.padEnd(8)
                                        : "—".padEnd(8)}
                                </Text>
                                <Text dimColor>{s.timePerPct ?? "—"}</Text>
                            </Box>
                        </Box>
                    );
                })}
            </Box>
        );
    }

    // Side-by-side not implemented yet — fall back to stacked
    return (
        <Box paddingX={1}>
            <Text dimColor>{"Side-by-side layout coming soon. Press [l] for stacked."}</Text>
        </Box>
    );
}
