import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { NotificationManager } from "@genesiscz/utils/ai/usage-poll/notifications";
import { usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import { logger } from "@genesiscz/utils/logger";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PollState, UsageAccountRef, UsageDataSource } from "../types";

export interface PollerOptions {
    source: UsageDataSource;
    accountFilter?: string[];
    paused: boolean;
    pollIntervalSeconds: number;
}

/**
 * The reducer half of the poller, extracted so it can be tested without Ink
 * (there is no render harness in this repo, spec 7.6). It is the rule that a
 * failed round keeps the last accounts on screen instead of blanking them.
 */
export function nextPollState(previous: PollState | null, outcome: PollOutcome): PollState {
    if (outcome.ok) {
        return { accounts: outcome.accounts, timestamp: outcome.at };
    }

    return { accounts: previous?.accounts ?? [], timestamp: outcome.at, error: outcome.error };
}

export type PollOutcome =
    | { ok: true; accounts: AccountUsageSnapshot[]; at: Date }
    | { ok: false; error: string; at: Date };

/** Every window that should raise a notification, flattened out of a round. */
export function notifiableWindows(snapshots: readonly AccountUsageSnapshot[]): Array<{
    accountName: string;
    key: string;
    kind: AccountUsageSnapshot["limits"][number]["kind"];
    label: string;
    utilization: number;
    resetsAt: string | null;
}> {
    const out: Array<{
        accountName: string;
        key: string;
        kind: AccountUsageSnapshot["limits"][number]["kind"];
        label: string;
        utilization: number;
        resetsAt: string | null;
    }> = [];

    for (const snapshot of snapshots) {
        // Stale entries replay an older fetch — notifying on them would re-fire
        // thresholds already handled.
        if (snapshot.stale || snapshot.error) {
            continue;
        }

        for (const window of snapshot.limits) {
            if (typeof window.percentUsed !== "number" || !Number.isFinite(window.percentUsed)) {
                continue;
            }

            out.push({
                accountName: snapshot.accountName,
                key: window.key,
                kind: window.kind,
                label: window.label,
                utilization: window.percentUsed,
                resetsAt: window.resetsAt ?? null,
            });
        }
    }

    return out;
}

export function usePoller({ source, accountFilter, paused, pollIntervalSeconds }: PollerOptions) {
    const [results, setResults] = useState<PollState | null>(null);
    const [accountRefs, setAccountRefs] = useState<UsageAccountRef[]>([]);
    const [pollingLabel, setPollingLabel] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [nextRefresh, setNextRefresh] = useState<Date | null>(null);
    const [dbVersion, setDbVersion] = useState(0);

    const notifRef = useRef<NotificationManager | null>(null);
    const notifReadyRef = useRef<Promise<void> | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pruneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollingRef = useRef(false);
    const pendingForceRef = useRef(false);

    const { config, limitsDb } = source;

    useEffect(() => {
        notifRef.current = new NotificationManager(config.notifications);

        // Persist tracker state across TUI launches so an over-threshold window does
        // not re-notify on every open. The ready promise is awaited by poll() so the
        // first fetch never races ahead of loadState.
        const manager = notifRef.current;
        const storage = usagePollStorage();
        notifReadyRef.current = storage
            .ensureDirs()
            .then(() => manager.loadState(storage))
            .catch((err) => logger.warn({ err }, "[ai-usage] notification state load failed"));

        limitsDb?.pruneOlderThan(config.dataRetentionDays);
        pruneIntervalRef.current = setInterval(
            () => {
                limitsDb?.pruneOlderThan(config.dataRetentionDays);
            },
            60 * 60 * 1000
        );

        return () => {
            if (pruneIntervalRef.current) {
                clearInterval(pruneIntervalRef.current);
            }
        };
    }, [config.dataRetentionDays, config.notifications, limitsDb]);

    const poll = useCallback(
        async (force = false) => {
            if (pollingRef.current) {
                // A forced refresh landing mid-poll must not be silently dropped —
                // queue it and replay once the in-flight poll settles.
                if (force) {
                    pendingForceRef.current = true;
                }

                return;
            }

            pollingRef.current = true;
            setPollingLabel("...");
            const at = new Date();

            try {
                const refs = await source.accounts();
                setAccountRefs(refs);
                setPollingLabel(refs.map((r) => r.name).join(", ") || "...");

                const snapshots = await source.poll({ force, accountFilter });

                if (notifReadyRef.current) {
                    await notifReadyRef.current;
                }

                for (const window of notifiableWindows(snapshots)) {
                    try {
                        await notifRef.current?.processUsage(window);
                    } catch (err) {
                        logger.warn({ err, account: window.accountName }, "[ai-usage] notification failed");
                    }
                }

                notifRef.current?.markFirstPollDone();
                notifRef.current?.autoDismissOld();
                void notifRef.current
                    ?.saveState(usagePollStorage())
                    .catch((err) => logger.warn({ err }, "[ai-usage] notification state save failed"));

                setResults((prev) => nextPollState(prev, { ok: true, accounts: snapshots, at }));
                setDbVersion((v) => v + 1);
                setLastRefresh(at);
                setNextRefresh(new Date(at.getTime() + pollIntervalSeconds * 1000));
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                logger.warn({ err }, "[ai-usage] poll round failed");
                setResults((prev) => nextPollState(prev, { ok: false, error, at }));
            } finally {
                pollingRef.current = false;
                setPollingLabel(null);

                if (pendingForceRef.current) {
                    // Cleared before the replay so a queued force runs exactly once.
                    pendingForceRef.current = false;
                    void poll(true);
                }
            }
        },
        [source, accountFilter, pollIntervalSeconds]
    );

    const forceRefresh = useCallback(() => poll(true), [poll]);

    useEffect(() => {
        void poll();
    }, [poll]);

    useEffect(() => {
        if (paused) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }

            return;
        }

        intervalRef.current = setInterval(() => void poll(), pollIntervalSeconds * 1000);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [paused, pollIntervalSeconds, poll]);

    return {
        results,
        accountRefs,
        pollingLabel,
        lastRefresh,
        nextRefresh,
        dbVersion,
        notifications: notifRef.current,
        forceRefresh,
    };
}
