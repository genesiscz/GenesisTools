import type { AccountUsageSnapshot, UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import { prominentFor, type UsageDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { useTerminalSize } from "@genesiscz/utils/ink/hooks/use-terminal-size";
import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { PollState } from "../types";
import { GenericAccountSection, orderWindows } from "./account-section";

export type OverviewSortMode = "config" | "urgency";

/** Frame chrome: filter bar(1) + tab bar(1) + status bar(2) + paddingY(2) + clamp(1). */
const CHROME_LINES = 7;

const COLUMN_GAP = 2;

/** Narrowest a column may be before two columns stop being an improvement. */
const DEFAULT_MIN_COLUMN_WIDTH = 40;

export interface OverviewViewProps {
    results: PollState | null;
    config: UsageDashboardConfig;
    presenters: Record<string, UsagePresenters | undefined>;
    sortMode?: OverviewSortMode;
}

/** Highest window percent on a snapshot, the default urgency key. */
export function urgencyOf(snapshot: AccountUsageSnapshot): number {
    let highest = -1;

    for (const window of snapshot.limits) {
        if (typeof window.percentUsed === "number" && window.percentUsed > highest) {
            highest = window.percentUsed;
        }
    }

    return highest;
}

/**
 * Sort one provider's snapshots with its own presenter when it has one, so an
 * `anthropic-sub` block keeps `scoreAccounts` while a codex block falls back to the
 * generic "most spent first". Config order is preserved when `sortMode` is `config`.
 */
export function sortSnapshots(
    snapshots: readonly AccountUsageSnapshot[],
    presenters: Record<string, UsagePresenters | undefined>,
    sortMode: OverviewSortMode
): AccountUsageSnapshot[] {
    if (sortMode === "config") {
        return [...snapshots];
    }

    const byProvider = new Map<string, AccountUsageSnapshot[]>();

    for (const snapshot of snapshots) {
        const list = byProvider.get(snapshot.provider) ?? [];
        list.push(snapshot);
        byProvider.set(snapshot.provider, list);
    }

    const out: AccountUsageSnapshot[] = [];

    for (const [provider, list] of byProvider) {
        const score = presenters[provider]?.score;
        out.push(...(score ? score(list) : [...list].sort((a, b) => urgencyOf(b) - urgencyOf(a))));
    }

    return out;
}

/**
 * Rendered lines of one account block. A presenter that draws more than the generic bars
 * supplies its own estimate; without one the count is the title, the windows it will show
 * and the trailing margin, which is exactly what `GenericAccountSection` emits.
 */
export function estimateHeight(
    snapshot: AccountUsageSnapshot,
    presenters: Record<string, UsagePresenters | undefined>,
    opts: { width: number; prominent: string[] }
): number {
    const own = presenters[snapshot.provider]?.estimateHeight;

    if (own) {
        return own(snapshot, opts);
    }

    const windows = orderWindows(snapshot.limits, opts.prominent).length;

    return 2 + Math.max(windows, 1) + (snapshot.error ? 1 : 0);
}

/** Split into two columns balanced by rendered height, order preserved. */
export function splitByHeight(
    snapshots: readonly AccountUsageSnapshot[],
    heights: readonly number[]
): [AccountUsageSnapshot[], AccountUsageSnapshot[]] {
    const total = heights.reduce((sum, h) => sum + h, 0);
    let left = 0;
    let splitAt = snapshots.length;

    for (let i = 0; i < snapshots.length; i++) {
        if (left + heights[i] / 2 > total / 2) {
            splitAt = i;
            break;
        }

        left += heights[i];
    }

    const at = Math.max(1, splitAt);

    return [snapshots.slice(0, at), snapshots.slice(at)];
}

export function OverviewView({ results, config, presenters, sortMode = "urgency" }: OverviewViewProps) {
    const { columns: termWidth, rows: termHeight } = useTerminalSize();
    const [, setTick] = useState(0);

    const accounts = useMemo(
        () => sortSnapshots(results?.accounts ?? [], presenters, sortMode),
        [results?.accounts, presenters, sortMode]
    );

    // Countdowns are time-derived; one coarse tick keeps them fresh without a
    // 1s interval per window row.
    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 30_000);
        return () => clearInterval(timer);
    }, []);

    if (!results) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"Loading usage data..."}</Text>
            </Box>
        );
    }

    // A full-screen error only when there is nothing at all to show. With last-good data
    // on hand the failure degrades to a banner above the account blocks.
    if (results.error && accounts.length === 0) {
        return (
            <Box paddingX={1} flexDirection="column">
                <Text color="red" bold>
                    {"Error"}
                </Text>
                <Text color="red">{results.error}</Text>
            </Box>
        );
    }

    if (accounts.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No accounts to show. Run: tools ai accounts list"}</Text>
            </Box>
        );
    }

    const banner = results.error ? <Text color="yellow">{`  ⚠ Last poll failed: ${results.error}`}</Text> : null;
    const singleWidth = Math.max(40, termWidth - 2);
    const columnWidth = Math.floor((termWidth - 2 - COLUMN_GAP) / 2);
    const minColumnWidth = Math.max(
        DEFAULT_MIN_COLUMN_WIDTH,
        ...accounts.map((s) => presenters[s.provider]?.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH)
    );

    const render = (snapshot: AccountUsageSnapshot, width: number) => {
        const prominent = prominentFor(config, snapshot.provider);
        const Presenter = presenters[snapshot.provider]?.AccountSection;
        const key = `${snapshot.provider}:${snapshot.accountName}`;

        if (Presenter) {
            return <Presenter key={key} snapshot={snapshot} width={width} prominent={prominent} />;
        }

        return <GenericAccountSection key={key} snapshot={snapshot} width={width} prominent={prominent} />;
    };

    const totalHeight = accounts.reduce(
        (sum, snapshot) =>
            sum +
            estimateHeight(snapshot, presenters, {
                width: singleWidth,
                prominent: prominentFor(config, snapshot.provider),
            }),
        0
    );
    const availableRows = termHeight - CHROME_LINES - (banner ? 1 : 0);
    const useTwoColumns = accounts.length > 1 && totalHeight > availableRows && columnWidth >= minColumnWidth;

    if (!useTwoColumns) {
        return (
            <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
                {banner}
                {accounts.map((snapshot) => render(snapshot, singleWidth))}
            </Box>
        );
    }

    const [left, right] = splitByHeight(
        accounts,
        accounts.map((snapshot) =>
            estimateHeight(snapshot, presenters, {
                width: columnWidth,
                prominent: prominentFor(config, snapshot.provider),
            })
        )
    );

    return (
        <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            {banner}
            <Box flexDirection="row">
                <Box flexDirection="column" width={columnWidth} marginRight={COLUMN_GAP}>
                    {left.map((snapshot) => render(snapshot, columnWidth))}
                </Box>
                <Box flexDirection="column" width={columnWidth}>
                    {right.map((snapshot) => render(snapshot, columnWidth))}
                </Box>
            </Box>
        </Box>
    );
}
