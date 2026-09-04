import type { AccountUsageSnapshot, UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import { prominentFor, type UsageDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { useTerminalSize } from "@genesiscz/utils/ink/hooks/use-terminal-size";
import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { PollState } from "../types";
import { GenericAccountSection } from "./account-section";

export type OverviewSortMode = "config" | "urgency";

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

export function OverviewView({ results, config, presenters, sortMode = "urgency" }: OverviewViewProps) {
    const { columns: termWidth } = useTerminalSize();
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

    if (accounts.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No accounts to show. Run: tools ai accounts list"}</Text>
            </Box>
        );
    }

    const width = Math.max(40, termWidth - 2);

    return (
        <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            {results?.error ? <Text color="yellow">{`  ⚠ Last poll failed: ${results.error}`}</Text> : null}
            {accounts.map((snapshot) => {
                const Presenter = presenters[snapshot.provider]?.AccountSection;

                if (Presenter) {
                    return (
                        <Presenter
                            key={`${snapshot.provider}:${snapshot.accountName}`}
                            snapshot={snapshot}
                            width={width}
                        />
                    );
                }

                return (
                    <GenericAccountSection
                        key={`${snapshot.provider}:${snapshot.accountName}`}
                        snapshot={snapshot}
                        width={width}
                        prominent={prominentFor(config, snapshot.provider)}
                    />
                );
            })}
        </Box>
    );
}
