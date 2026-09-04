import type { SeriesEntry, UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { logger } from "@genesiscz/utils/logger";
import { Box, Text, useStdout } from "ink";
import { useMemo } from "react";
import { useScroll } from "../hooks/use-scroll";
import { colorForPercent } from "../lib/colors";
import { formatTimeRange } from "../types";

export interface HistoryViewProps {
    db: UsageLimitsDb | null;
    dbVersion: number;
    /** Minutes. Owned by the filter bar so Overview pacing and History agree. */
    timeRange: number;
    /** Plugin ids the dashboard is pinned to. One provider means one `getSeries` call. */
    providers: string[];
    accountFilter?: string[];
}

export interface HistoryRow {
    account: string;
    key: string;
    t: string;
    percent: number;
    /** Change from the previous point of the same series, null on the first one. */
    delta: number | null;
}

/** Flatten `getSeries` output into newest-first rows with per-series deltas. */
export function seriesToRows(series: readonly SeriesEntry[]): HistoryRow[] {
    const rows: HistoryRow[] = [];

    for (const entry of series) {
        for (let i = 0; i < entry.points.length; i++) {
            const point = entry.points[i];
            const previous = i > 0 ? entry.points[i - 1] : null;

            rows.push({
                account: entry.account,
                key: entry.key,
                t: point.t,
                percent: point.percent,
                delta: previous ? point.percent - previous.percent : null,
            });
        }
    }

    rows.sort((a, b) => (a.account === b.account ? b.t.localeCompare(a.t) : a.account.localeCompare(b.account)));

    return rows;
}

function formatTimestamp(ts: string): string {
    return new Date(ts).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

export function HistoryView({ db, dbVersion, timeRange, providers, accountFilter }: HistoryViewProps) {
    const { stdout } = useStdout();
    const termHeight = stdout?.rows ?? 24;
    // Chrome: TabBar(1) + FilterBar(1) + StatusBar(3) + paddingY(2) + hint(1) + header(1).
    const availableLines = Math.max(3, termHeight - 9);

    const rows = useMemo(() => {
        if (!db) {
            return [];
        }

        const to = new Date().toISOString();
        const from = new Date(Date.now() - timeRange * 60_000).toISOString();
        const series: SeriesEntry[] = [];

        try {
            if (providers.length === 0) {
                series.push(...db.getSeries({ from, to, accounts: accountFilter }));
            } else {
                for (const provider of providers) {
                    series.push(...db.getSeries({ provider, from, to, accounts: accountFilter }));
                }
            }
        } catch (err) {
            // A locked or missing DB must not take the dashboard down with it; the view
            // renders its "no history yet" line and the log carries the real reason.
            logger.warn({ err, providers, timeRange }, "[ai-usage] history read failed");
            return [];
        }

        return seriesToRows(series);
        // `dbVersion` is the poll counter: it is the only signal that the rows changed.
    }, [db, timeRange, providers, accountFilter, dbVersion]);

    const { offset } = useScroll({
        totalItems: rows.length,
        pageSize: availableLines,
        enabled: true,
        vimKeys: true,
    });

    if (!db || rows.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No history data yet. Data will appear after a few polls."}</Text>
            </Box>
        );
    }

    const visible = rows.slice(offset, offset + availableLines);
    const from = rows.length > 0 ? offset + 1 : 0;
    const to = Math.min(offset + visible.length, rows.length);

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1} height={Math.max(8, termHeight - 4)} overflow="hidden">
            <Box justifyContent="space-between">
                <Text>
                    <Text dimColor>{"last "}</Text>
                    <Text color="cyan" bold>
                        {formatTimeRange(timeRange)}
                    </Text>
                    <Text dimColor>{"   f range · j/k ↑↓ scroll"}</Text>
                </Text>
                <Text dimColor>{`${from}–${to} of ${rows.length}`}</Text>
            </Box>
            <Box>
                <Text bold dimColor>
                    {`${"Account".padEnd(18)}${"Time".padEnd(10)}${"Window".padEnd(14)}${"Util %".padEnd(9)}Δ%`}
                </Text>
            </Box>
            {visible.map((row, i) => (
                <Box key={`${row.account}-${row.key}-${row.t}-${i}`}>
                    <Text color="cyan">{row.account.slice(0, 17).padEnd(18)}</Text>
                    <Text dimColor>{formatTimestamp(row.t).padEnd(10)}</Text>
                    <Text color="magenta">{row.key.slice(0, 13).padEnd(14)}</Text>
                    <Text bold color={colorForPercent(row.percent)}>
                        {`${row.percent.toFixed(1)}%`.padEnd(9)}
                    </Text>
                    {row.delta === null ? (
                        <Text dimColor>{"—"}</Text>
                    ) : (
                        <Text color={row.delta > 0 ? "yellow" : row.delta < 0 ? "green" : undefined}>
                            {`${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)}`}
                        </Text>
                    )}
                </Box>
            ))}
        </Box>
    );
}
