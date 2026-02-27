import { loadConfig, type AccountConfig } from "@app/claude/lib/config";
import {
    fetchAllAccountsUsage,
    getKeychainCredentials,
} from "@app/claude/lib/usage/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import type { PollResult } from "../types";

interface PollerOptions {
    config: UsageDashboardConfig;
    accountFilter?: string;
    paused: boolean;
    pollIntervalSeconds: number;
}

export function useUsagePoller({ config, accountFilter, paused, pollIntervalSeconds }: PollerOptions) {
    const [results, setResults] = useState<PollResult | null>(null);
    const [isPolling, setIsPolling] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [nextRefresh, setNextRefresh] = useState<Date | null>(null);

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

        pruneIntervalRef.current = setInterval(() => {
            dbRef.current?.pruneOlderThan(config.dataRetentionDays);
        }, 60 * 60 * 1000);

        return () => {
            dbRef.current?.close();

            if (pruneIntervalRef.current) {
                clearInterval(pruneIntervalRef.current);
            }
        };
    }, []);

    const poll = useCallback(async () => {
        if (pollingRef.current) {
            return;
        }

        pollingRef.current = true;
        setIsPolling(true);

        try {
            if (Object.keys(accountsRef.current).length === 0) {
                const cfg = await loadConfig();
                let accounts = cfg.accounts;

                if (Object.keys(accounts).length === 0) {
                    const kc = await getKeychainCredentials();

                    if (kc) {
                        accounts = {
                            default: {
                                accessToken: kc.accessToken,
                                label: kc.subscriptionType,
                            },
                        };
                    }
                }

                if (accountFilter) {
                    accounts = accounts[accountFilter]
                        ? { [accountFilter]: accounts[accountFilter] }
                        : accounts;
                }

                accountsRef.current = accounts;
            }

            const accountUsages = await fetchAllAccountsUsage(accountsRef.current);
            const now = new Date();

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

                    dbRef.current?.recordIfChanged(
                        account.accountName,
                        bucket,
                        data.utilization,
                        data.resets_at
                    );

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
            setLastRefresh(now);
            setNextRefresh(new Date(now.getTime() + pollIntervalSeconds * 1000));
        } catch (error) {
            setResults({
                accounts: [],
                timestamp: new Date(),
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            pollingRef.current = false;
            setIsPolling(false);
        }
    }, [accountFilter, config, pollIntervalSeconds]);

    useEffect(() => {
        poll();
    }, []);

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
        isPolling,
        lastRefresh,
        nextRefresh,
        db: dbRef.current,
        notifications: notifRef.current,
        forceRefresh: poll,
    };
}
