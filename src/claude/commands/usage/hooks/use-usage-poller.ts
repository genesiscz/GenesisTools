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
                        notifRef.current?.processUsage(
                            account.accountName,
                            bucket,
                            data.utilization,
                            data.resets_at
                        );
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
            // Cache key per account filter so filtered views don't share results with full views
            const cacheKey = `poll-results-${accountFilter ?? "all"}.json`;
            // TTL: use pollInterval minus a small buffer so cache expires just before the next poll
            const ttlSeconds = Math.max(3, pollIntervalSeconds - 2);
            const cached = await storage.getCacheFile<PollCache>(cacheKey, `${ttlSeconds} seconds`);

            if (cached) {
                // Fresh data already fetched by another instance — reuse it
                processAccountUsages(cached.accounts, new Date(cached.timestamp));
                return;
            }

            // Always reload config — tokens may have been refreshed by daemon or another process
            const cfg = await loadConfig();
            let accounts = cfg.accounts;

            if (accountFilter) {
                accounts = accounts[accountFilter] ? { [accountFilter]: accounts[accountFilter] } : {};
            }

            accountsRef.current = accounts;

            setPollingLabel(Object.keys(accountsRef.current).join(", ") || "...");

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            let accountUsages: AccountUsage[];

            try {
                accountUsages = await fetchAllAccountsUsage(accountsRef.current);
            } finally {
                clearTimeout(timeout);
            }

            const now = new Date();

            // Persist for other instances to reuse within the same interval
            await storage.putCacheFile<PollCache>(cacheKey, { timestamp: now.toISOString(), accounts: accountUsages }, `${pollIntervalSeconds} seconds`);

            processAccountUsages(accountUsages, now);
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
