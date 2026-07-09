import { refreshAccountLabels } from "@app/claude/lib/config";
import type { AccountUsage } from "@app/claude/lib/usage/api";
import { isUsageBucket } from "@app/claude/lib/usage/api";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import { logger } from "@app/logger";
import { Storage } from "@app/utils/storage/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PollResult } from "../types";

interface PollerOptions {
    config: UsageDashboardConfig;
    accountFilter?: string;
    paused: boolean;
    pollIntervalSeconds: number;
}

export function useUsagePoller({ config, accountFilter, paused, pollIntervalSeconds }: PollerOptions) {
    const [results, setResults] = useState<PollResult | null>(null);
    const [pollingLabel, setPollingLabel] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [nextRefresh, setNextRefresh] = useState<Date | null>(null);
    const [dbVersion, setDbVersion] = useState(0);

    const dbRef = useRef<UsageHistoryDb | null>(null);
    const notifRef = useRef<NotificationManager | null>(null);
    const notifStorageRef = useRef<Storage | null>(null);
    const notifReadyRef = useRef<Promise<void> | null>(null);
    const accountNamesRef = useRef<string[]>([]);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pruneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollingRef = useRef(false);

    useEffect(() => {
        // Refresh account labels from API profiles on startup (best-effort, non-blocking)
        refreshAccountLabels().catch((err) =>
            logger.debug({ error: err }, "[claude-usage] refreshAccountLabels failed")
        );

        dbRef.current = new UsageHistoryDb();
        notifRef.current = new NotificationManager(config.notifications);

        // Persist notification tracker state across TUI launches so we don't
        // re-fire "[INIT]" alerts every time the dashboard opens — matches the
        // pattern used by poll-daemon.ts. Without this, every launch sees
        // isFirstPoll=true and any over-threshold bucket re-notifies.
        // The ready promise is awaited by poll() so the first fetch never races
        // ahead of loadState — that race was the lingering spam source.
        notifStorageRef.current = new Storage("claude-usage");
        const notifManagerForLoad = notifRef.current;
        const storageForLoad = notifStorageRef.current;
        notifReadyRef.current = storageForLoad
            .ensureDirs()
            .then(() => notifManagerForLoad.loadState(storageForLoad))
            .catch((err) => logger.warn({ error: err }, "[claude-usage] notification state load failed"));

        dbRef.current.pruneOlderThan(config.dataRetentionDays);

        pruneIntervalRef.current = setInterval(
            () => {
                dbRef.current?.pruneOlderThan(config.dataRetentionDays);
            },
            60 * 60 * 1000
        );

        return () => {
            dbRef.current?.close();

            if (pruneIntervalRef.current) {
                clearInterval(pruneIntervalRef.current);
            }
        };
    }, [config.dataRetentionDays, config.notifications]);

    // Process account usages into DB and notifications (shared by both cached and fresh paths)
    const processAccountUsages = useCallback(
        (accountUsages: AccountUsage[], now: Date) => {
            for (const account of accountUsages) {
                // Stale entries replay an older fetch — notifying on them
                // could re-fire thresholds already handled.
                if (!account.usage || account.stale) {
                    continue;
                }

                for (const [bucket, data] of Object.entries(account.usage)) {
                    if (!isUsageBucket(data)) {
                        continue;
                    }

                    if (data.utilization === null || data.utilization === undefined) {
                        continue;
                    }

                    // History writes are owned by shared-cache.recordAll (V2 path with severity).
                    // Re-recording here via the legacy V1 path inserted a parallel null-severity row
                    // every poll, mutually poisoning the V2 dedup check (null != "critical") so both
                    // writers kept inserting flat-value rows forever.

                    try {
                        notifRef.current?.processUsage(account.accountName, bucket, data.utilization, data.resets_at);
                    } catch (err) {
                        logger.warn(
                            { error: err, account: account.accountName, bucket },
                            "[claude-usage] processUsage notification failed"
                        );
                    }
                }
            }

            notifRef.current?.markFirstPollDone();
            notifRef.current?.autoDismissOld();

            // Persist tracker state so the next TUI launch / poll knows which
            // thresholds have already notified (mirrors poll-daemon's save pass).
            const notifManager = notifRef.current;
            const notifStorage = notifStorageRef.current;
            if (notifManager && notifStorage) {
                notifManager.saveState(notifStorage).catch((err) => {
                    logger.warn({ error: err }, "[claude-usage] notification state save failed");
                });
            }

            setResults({ accounts: accountUsages, timestamp: now });
            setDbVersion((v) => v + 1);
            setLastRefresh(now);
            setNextRefresh(new Date(now.getTime() + pollIntervalSeconds * 1000));
        },
        [pollIntervalSeconds]
    );

    const poll = useCallback(async (force = false) => {
        if (pollingRef.current) {
            return;
        }

        pollingRef.current = true;
        setPollingLabel("...");

        try {
            // Resolve which accounts to poll from AIConfig
            const { AIConfig } = await import("@app/utils/ai/AIConfig");
            const aiConfig = await AIConfig.load();
            let allAccounts = aiConfig.getAccountsByProvider("anthropic-sub");

            if (accountFilter) {
                allAccounts = allAccounts.filter((a) => a.name === accountFilter);
            }

            const accountNames = allAccounts.map((a) => a.name);
            accountNamesRef.current = accountNames;
            setPollingLabel(accountNames.join(", ") || "...");

            // All consumers (daemon, dashboard, this TUI, watch) share one cache
            // bucket: Anthropic is hit at most once per 30s and every live fetch
            // write-throughs to history. The R key forces past that cap; interval
            // polls stay unforced so background polling keeps the courtesy limit.
            const resolvedUsages = await getSharedAccountsUsage({ accountFilter, force });

            // Block on notification-state load so the first poll never races
            // ahead of loadState() and re-fires every over-threshold alert.
            if (notifReadyRef.current) {
                await notifReadyRef.current;
            }

            if (resolvedUsages.length > 0) {
                processAccountUsages(resolvedUsages, new Date());
            }
        } catch (error) {
            // Keep whatever we last rendered — a failed poll (no cache to fall
            // back on) shouldn't blank out data the user is already looking at.
            setResults((prev) => ({
                accounts: prev?.accounts ?? [],
                timestamp: new Date(),
                error: error instanceof Error ? error.message : String(error),
            }));
        } finally {
            pollingRef.current = false;
            setPollingLabel(null);
        }
    }, [accountFilter, pollIntervalSeconds, processAccountUsages]);

    const forceRefresh = useCallback(() => poll(true), [poll]);

    useEffect(() => {
        poll();
    }, [poll]);

    useEffect(() => {
        if (paused) {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        intervalRef.current = setInterval(poll, pollIntervalSeconds * 1000);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [paused, pollIntervalSeconds, poll]);

    return {
        results,
        pollingLabel,
        lastRefresh,
        nextRefresh,
        db: dbRef.current,
        dbVersion,
        notifications: notifRef.current,
        forceRefresh,
    };
}
