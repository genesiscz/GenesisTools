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
        setPollingLabel("...");

        try {
            const ttlSeconds = Math.max(3, pollIntervalSeconds - 2);

            // Resolve which accounts to poll
            const cfg = await loadConfig();
            let accounts = cfg.accounts;

            if (accountFilter) {
                accounts = accounts[accountFilter] ? { [accountFilter]: accounts[accountFilter] } : {};
            }

            accountsRef.current = accounts;
            const accountNames = Object.keys(accounts);
            setPollingLabel(accountNames.join(", ") || "...");

            // Per-account locking: each account gets its own cache + lock
            // This ensures "tools claude usage" and "tools claude usage --filter foo"
            // share the same lock for account "foo" instead of racing.
            const accountUsages: AccountUsage[] = [];

            await Promise.all(
                Object.entries(accounts).map(async ([name, account]) => {
                    const cacheKey = `poll-account-${name}.json`;

                    // Fast path: check cache without lock
                    const cached = await storage.getCacheFile<AccountUsage>(cacheKey, `${ttlSeconds} seconds`);

                    if (cached) {
                        accountUsages.push(cached);
                        return;
                    }

                    // Cache stale — acquire per-account lock
                    const cacheFilePath = join(storage.getCacheDir(), cacheKey);
                    const result = await storage.withFileLock({
                        file: cacheFilePath,
                        fn: async (): Promise<AccountUsage | null> => {
                            const freshCached = await storage.getCacheFile<AccountUsage>(
                                cacheKey,
                                `${ttlSeconds} seconds`
                            );

                            if (freshCached) {
                                return freshCached;
                            }

                            const [usage] = await fetchAllAccountsUsage({ [name]: account });

                            try {
                                await storage.putCacheFile(cacheKey, usage, `${pollIntervalSeconds} seconds`);
                            } catch {
                                // Cache write is best-effort
                            }

                            return usage;
                        },
                        timeout: 10_000,
                        onTimeout: () => null,
                    });

                    if (result) {
                        accountUsages.push(result);
                    }
                })
            );

            if (accountUsages.length > 0) {
                processAccountUsages(accountUsages, new Date());
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
