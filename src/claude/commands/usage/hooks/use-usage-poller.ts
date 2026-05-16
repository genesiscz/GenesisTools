import { refreshAccountLabels } from "@app/claude/lib/config";
import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
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
    const accountNamesRef = useRef<string[]>([]);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pruneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollingRef = useRef(false);

    useEffect(() => {
        // Refresh account labels from API profiles on startup (best-effort, non-blocking)
        refreshAccountLabels().catch(() => {});

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
            // write-throughs to history.
            const resolvedUsages = await getSharedAccountsUsage({ accountFilter });

            if (resolvedUsages.length > 0) {
                processAccountUsages(resolvedUsages, new Date());
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
