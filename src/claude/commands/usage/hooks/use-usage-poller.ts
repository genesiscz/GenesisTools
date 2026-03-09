import { join } from "node:path";
import { type AccountConfig, loadConfig } from "@app/claude/lib/config";
import { type AccountUsage, fetchAllAccountsUsage } from "@app/claude/lib/usage/api";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import { Storage } from "@app/utils/storage/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PollResult } from "../types";

interface PollerOptions {
    config: UsageDashboardConfig;
    accountFilter?: string;
    paused: boolean;
    pollIntervalSeconds: number;
}

interface PollCache {
    timestamp: string;
    accounts: AccountUsage[];
}

// Shared across all instances of the tool process — storage is per-user on disk
const storage = new Storage("claude-usage");

export function useUsagePoller({ config, accountFilter, paused, pollIntervalSeconds }: PollerOptions) {
    const [results, setResults] = useState<PollResult | null>(null);
    const [pollingLabel, setPollingLabel] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [nextRefresh, setNextRefresh] = useState<Date | null>(null);
    const [dbVersion, setDbVersion] = useState(0);

    const dbRef = useRef<UsageHistoryDb | null>(null);
    const notifRef = useRef<NotificationManager | null>(null);
    const accountsRef = useRef<Record<string, AccountConfig>>({});
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pruneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollingRef = useRef(false);

    useEffect(() => {
        dbRef.current = new UsageHistoryDb();
        notifRef.current = new NotificationManager(config.notifications);

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
                if (!account.usage) {
                    continue;
                }

                for (const [bucket, data] of Object.entries(account.usage)) {
                    if (!data || typeof data !== "object" || !("utilization" in data)) {
                        continue;
                    }

                    if (data.utilization === null || data.utilization === undefined) {
                        continue;
                    }

                    dbRef.current?.recordIfChanged(account.accountName, bucket, data.utilization, data.resets_at);

                    try {
                        notifRef.current?.processUsage(account.accountName, bucket, data.utilization, data.resets_at);
                    } catch {
                        // Notification failure should not interrupt polling
                    }
                }
            }

            notifRef.current?.markFirstPollDone();
            notifRef.current?.autoDismissOld();

            setResults({ accounts: accountUsages, timestamp: now });
            setDbVersion((v) => v + 1);
            setLastRefresh(now);
            setNextRefresh(new Date(now.getTime() + pollIntervalSeconds * 1000));
        },
        [pollIntervalSeconds]
    );

    const poll = useCallback(async () => {
        if (pollingRef.current) {
            return;
        }

        pollingRef.current = true;
        const names = Object.keys(accountsRef.current);
        setPollingLabel(names.length > 0 ? names.join(", ") : "...");

        try {
            const cacheKey = `poll-results-${accountFilter ?? "all"}.json`;
            const ttlSeconds = Math.max(3, pollIntervalSeconds - 2);

            // Check cache first WITHOUT lock (fast path — avoids lock contention when cache is fresh)
            const cached = await storage.getCacheFile<PollCache>(cacheKey, `${ttlSeconds} seconds`);

            if (cached) {
                processAccountUsages(cached.accounts, new Date(cached.timestamp));
                return;
            }

            // Cache is stale — acquire lock and poll (or wait for another process that's already polling)
            const cacheFilePath = join(storage.getCacheDir(), cacheKey);
            const result = await storage.withFileLock({
                file: cacheFilePath,
                fn: async (): Promise<PollCache | null> => {
                    // Re-check cache inside lock — another process may have just written it
                    const freshCached = await storage.getCacheFile<PollCache>(cacheKey, `${ttlSeconds} seconds`);

                    if (freshCached) {
                        return freshCached;
                    }

                    // We're the winner — fetch fresh data
                    const cfg = await loadConfig();
                    let accounts = cfg.accounts;

                    if (accountFilter) {
                        accounts = accounts[accountFilter] ? { [accountFilter]: accounts[accountFilter] } : {};
                    }

                    accountsRef.current = accounts;
                    setPollingLabel(Object.keys(accountsRef.current).join(", ") || "...");

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10_000);
                    let accountUsages: AccountUsage[];

                    try {
                        accountUsages = await fetchAllAccountsUsage(accountsRef.current, controller.signal);
                    } finally {
                        clearTimeout(timeout);
                    }

                    const now = new Date();
                    const pollCache: PollCache = { timestamp: now.toISOString(), accounts: accountUsages };

                    try {
                        await storage.putCacheFile<PollCache>(cacheKey, pollCache, `${pollIntervalSeconds} seconds`);
                    } catch {
                        // Cache write is best-effort
                    }

                    return pollCache;
                },
                timeout: 10_000,
                onTimeout: () => {
                    // Lock timed out — return null, we'll try again next interval
                    return null;
                },
            });

            if (result) {
                processAccountUsages(result.accounts, new Date(result.timestamp));
            }
        } catch (error) {
            setResults({
                accounts: [],
                timestamp: new Date(),
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            pollingRef.current = false;
            setPollingLabel(null);
        }
    }, [accountFilter, pollIntervalSeconds, processAccountUsages]);

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
        forceRefresh: poll,
    };
}
