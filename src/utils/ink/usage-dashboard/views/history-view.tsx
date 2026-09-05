import type { SeriesEntry, UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { logger } from "@genesiscz/utils/logger";
import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
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
    /** Wall time per one percent of burn since the previous point; null when it did not rise. */
    timePerPercent: string | null;
}

/** `grouped` is the layout `tools claude usage` always had: one block per account. `flat` adds an Account column. */
export type HistoryLayout = "grouped" | "flat";

const SHORT_WINDOW_LABELS: Record<string, string> = {
    five_hour: "session",
    seven_day: "weekly",
    seven_day_opus: "opus",
    seven_day_sonnet: "sonnet",
    seven_day_oauth_apps: "oauth",
};

/** Short window label for the grouped table: `seven_day_fable` reads as `fable`, `product:grokbuild` as `grokbuild`. */
export function shortWindowLabel(key: string): string {
    const known = SHORT_WINDOW_LABELS[key];

    if (known) {
        return known;
    }

    if (key.startsWith("seven_day_")) {
        return key.slice("seven_day_".length);
    }

    if (key.startsWith("product:")) {
        return key.slice("product:".length);
    }

    return key;
}

export function formatTimePerPercent(deltaMs: number, deltaPercent: number): string | null {
    if (deltaMs <= 0 || deltaPercent <= 0) {
        return null;
    }

    const totalSec = Math.round(deltaMs / deltaPercent / 1000);

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

/** Flatten `getSeries` output into newest-first rows with per-series deltas, grouped by account. */
export function seriesToRows(series: readonly SeriesEntry[]): HistoryRow[] {
    const rows: HistoryRow[] = [];

    for (const entry of series) {
        for (let i = 0; i < entry.points.length; i++) {
            const point = entry.points[i];
            const previous = i > 0 ? entry.points[i - 1] : null;
            const delta = previous ? point.percent - previous.percent : null;
            const elapsedMs = previous ? Date.parse(point.t) - Date.parse(previous.t) : 0;

            rows.push({
                account: entry.account,
                key: entry.key,
                t: point.t,
                percent: point.percent,
                delta,
                timePerPercent: delta === null ? null : formatTimePerPercent(elapsedMs, delta),
            });
        }
    }

    rows.sort((a, b) => (a.account === b.account ? b.t.localeCompare(a.t) : a.account.localeCompare(b.account)));

    return rows;
}

/** Indices where a new account block starts: the j/k jump targets of the grouped layout. */
export function groupStarts(rows: readonly HistoryRow[]): number[] {
    const starts: number[] = [];

    for (let i = 0; i < rows.length; i++) {
        if (i === 0 || rows[i].account !== rows[i - 1].account) {
            starts.push(i);
        }
    }

    return starts;
}

/** Rendered line cost of one grouped row: the account header costs 1 line at the page top, 2 with its margin below. */
function rowCost(isGroupStart: boolean, isPageTop: boolean): number {
    return 1 + (isGroupStart ? (isPageTop ? 1 : 2) : 0);
}

/**
 * Largest scroll offset whose greedy fill (see `visibleRows` in the view) still reaches the
 * last row, so `G` and Ctrl+D land on a full last page. The flat `totalItems - pageSize`
 * formula undercounts here because group headers cost 2 or 3 lines, not 1. The row at a
 * candidate offset is always a forced page-top header, so its cost is constant.
 */
export function computeMaxOffset(rows: readonly HistoryRow[], availableLines: number): number {
    const n = rows.length;

    if (n === 0) {
        return 0;
    }

    const normalCost = rows.map((row, i) => rowCost(i === 0 || row.account !== rows[i - 1].account, false));
    const suffixFromNext = new Array<number>(n + 1).fill(0);

    for (let j = n - 1; j >= 0; j--) {
        suffixFromNext[j] = suffixFromNext[j + 1] + normalCost[j];
    }

    const pageTopCost = rowCost(true, true);

    for (let s = 0; s < n; s++) {
        if (pageTopCost + suffixFromNext[s + 1] <= availableLines) {
            return s;
        }
    }

    return n - 1;
}

/**
 * Greedily fill the viewport from `offset`: every row costs one line plus its account
 * header when it opens a block. This is what makes the list use the whole height instead
 * of reserving header lines for accounts that are not on screen.
 */
export function visibleGroupedRows(rows: readonly HistoryRow[], offset: number, availableLines: number): HistoryRow[] {
    const visible: HistoryRow[] = [];
    let lines = 0;

    for (let i = offset; i < rows.length; i++) {
        const isGroupStart = i === offset || rows[i].account !== rows[i - 1].account;
        const cost = rowCost(isGroupStart, visible.length === 0);

        if (lines + cost > availableLines) {
            break;
        }

        lines += cost;
        visible.push(rows[i]);
    }

    return visible;
}

function formatTimestamp(ts: string): string {
    return new Date(ts).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function DeltaCell({ delta, width }: { delta: number | null; width: number }) {
    if (delta === null) {
        return <Text dimColor>{"—".padEnd(width)}</Text>;
    }

    return (
        <Text color={delta > 0 ? "yellow" : delta < 0 ? "green" : undefined}>
            {`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`.padEnd(width)}
        </Text>
    );
}

export function HistoryView({ db, dbVersion, timeRange, providers, accountFilter }: HistoryViewProps) {
    const { stdout } = useStdout();
    const termHeight = stdout?.rows ?? 24;
    // Chrome: TabBar(1) + FilterBar(1) + StatusBar(3) + paddingY(2) + hint(1) + header(1).
    const availableLines = Math.max(3, termHeight - 9);
    const [layout, setLayout] = useState<HistoryLayout>("grouped");

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

    const starts = useMemo(() => groupStarts(rows), [rows]);
    const groupedMaxOffset = useMemo(() => computeMaxOffset(rows, availableLines), [rows, availableLines]);

    const { offset, setOffset } = useScroll({
        totalItems: rows.length,
        pageSize: availableLines,
        enabled: true,
        vimKeys: layout === "flat",
        maxOffsetOverride: layout === "grouped" ? groupedMaxOffset : undefined,
    });

    // A poll can shrink the list under the cursor; clamp instead of pinning the view blank.
    useEffect(() => {
        const maxOffset = layout === "grouped" ? groupedMaxOffset : Math.max(0, rows.length - availableLines);

        if (offset > maxOffset) {
            setOffset(maxOffset);
        }
    }, [layout, groupedMaxOffset, rows.length, availableLines, offset, setOffset]);

    useInput((input) => {
        if (input === "l") {
            setLayout((current) => (current === "grouped" ? "flat" : "grouped"));
            return;
        }

        if (layout !== "grouped") {
            return;
        }

        if (input === "j") {
            const next = starts.find((s) => s > offset);

            if (next !== undefined) {
                setOffset(Math.min(next, groupedMaxOffset));
            }
        }

        if (input === "k") {
            const previous = [...starts].reverse().find((s) => s < offset);
            setOffset(previous ?? 0);
        }
    });

    if (!db || rows.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No history data yet. Data will appear after a few polls."}</Text>
            </Box>
        );
    }

    const visible =
        layout === "grouped"
            ? visibleGroupedRows(rows, offset, availableLines)
            : rows.slice(offset, offset + availableLines);
    const from = offset + 1;
    const to = Math.min(offset + visible.length, rows.length);
    const hint =
        layout === "grouped"
            ? "   f range · l flat · j/k account · ↑↓ scroll"
            : "   f range · l grouped · j/k ↑↓ scroll";

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1} height={Math.max(8, termHeight - 4)} overflow="hidden">
            <Box justifyContent="space-between">
                <Text>
                    <Text dimColor>{"last "}</Text>
                    <Text color="cyan" bold>
                        {formatTimeRange(timeRange)}
                    </Text>
                    <Text dimColor>{hint}</Text>
                </Text>
                <Text dimColor>{`${from}–${to} of ${rows.length}`}</Text>
            </Box>
            {layout === "grouped" ? (
                <>
                    <Box>
                        <Text bold dimColor>
                            {`${"Time".padEnd(10)}${"Window".padEnd(12)}${"Util %".padEnd(9)}${"Δ%".padEnd(8)}Speed / 1%`}
                        </Text>
                    </Box>
                    {visible.map((row, i) => {
                        const showHeader = i === 0 || row.account !== visible[i - 1].account;

                        return (
                            <Box key={`${row.account}-${row.key}-${row.t}-${i}`} flexDirection="column">
                                {showHeader && (
                                    <Box marginTop={i > 0 ? 1 : 0}>
                                        <Text dimColor>{"● "}</Text>
                                        <Text bold color="cyan">
                                            {row.account}
                                        </Text>
                                    </Box>
                                )}
                                <Box>
                                    <Text dimColor>{formatTimestamp(row.t).padEnd(10)}</Text>
                                    <Text color="magenta">{shortWindowLabel(row.key).slice(0, 11).padEnd(12)}</Text>
                                    <Text bold color={colorForPercent(row.percent)}>
                                        {`${row.percent.toFixed(1)}%`.padEnd(9)}
                                    </Text>
                                    <DeltaCell delta={row.delta} width={8} />
                                    <Text dimColor>{row.timePerPercent ?? "—"}</Text>
                                </Box>
                            </Box>
                        );
                    })}
                </>
            ) : (
                <>
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
                            <DeltaCell delta={row.delta} width={0} />
                        </Box>
                    ))}
                </>
            )}
        </Box>
    );
}
