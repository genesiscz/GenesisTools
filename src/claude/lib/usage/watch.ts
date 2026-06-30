import type { NotificationConfig } from "@app/claude/lib/config";
import { out } from "@app/logger";
import { dispatchNotification } from "@app/utils/notifications";
import type { AccountUsage } from "./api";
import { renderAllAccounts } from "./display";
import type { Severity } from "./limits";
import { normalizeLimits } from "./limits";
import { getSharedAccountsUsage } from "./shared-cache";

const BUCKET_THRESHOLD_MAP: Record<string, "sessionThresholds" | "weeklyThresholds"> = {
    five_hour: "sessionThresholds",
    seven_day: "weeklyThresholds",
    seven_day_opus: "weeklyThresholds",
    seven_day_sonnet: "weeklyThresholds",
    seven_day_oauth_apps: "weeklyThresholds",
};

/**
 * Tracks notification state for a single bucket (e.g., "Livinka:seven_day")
 */
export type NotifyReason = "INIT" | "+5%" | "CRITICAL" | "WARNING";

class BucketTracker {
    private lastNotifiedPct: number | null = null;
    private lastResetAt: string | null = null;
    private lastSeverity: Severity = "normal";

    constructor(
        public readonly accountName: string,
        public readonly bucketName: string
    ) {}

    get key(): string {
        return `${this.accountName}:${this.bucketName}`;
    }

    get label(): string {
        return this.bucketName === "five_hour" ? "Session" : this.bucketName.replace(/_/g, " ");
    }

    /**
     * Check if we should notify for this bucket.
     * Returns notification reason or null if no notification needed.
     *
     * Severity escalations (normal→warning, *→critical) fire IMMEDIATELY
     * regardless of percent thresholds; percent thresholds are preserved
     * as before (additive — user-configured behavior unchanged).
     */
    shouldNotify(
        currentPct: number,
        resetAt: string | null,
        thresholds: number[],
        isFirstPoll: boolean,
        severity: Severity = "normal"
    ): NotifyReason | null {
        const normalizedReset = this.normalizeResetTime(resetAt);

        // Period reset detection - clear state if reset timestamp changed
        if (this.lastResetAt !== null && this.lastResetAt !== normalizedReset) {
            this.lastNotifiedPct = null;
            this.lastSeverity = "normal";
        }
        this.lastResetAt = normalizedReset;

        // Severity escalation — fires regardless of percent thresholds.
        // Skip on first poll: that's an INIT/percent-threshold case.
        if (!isFirstPoll && severity === "critical" && this.lastSeverity !== "critical") {
            this.lastSeverity = severity;
            this.lastNotifiedPct = currentPct;
            return "CRITICAL";
        }

        if (!isFirstPoll && severity === "warning" && this.lastSeverity === "normal") {
            this.lastSeverity = severity;
            this.lastNotifiedPct = currentPct;
            return "WARNING";
        }

        // Track latest severity even when we don't notify, so the next
        // escalation can fire.
        this.lastSeverity = severity;

        // Check if any percent threshold is crossed
        const crossedThreshold = thresholds.some((t) => currentPct >= t);
        if (!crossedThreshold) {
            return null;
        }

        // First poll: always notify if threshold crossed
        if (isFirstPoll) {
            this.lastNotifiedPct = currentPct;
            return "INIT";
        }

        // Never notified before (new bucket mid-session): notify
        if (this.lastNotifiedPct === null) {
            this.lastNotifiedPct = currentPct;
            return "INIT";
        }

        // Subsequent: only notify if 5% increase
        if (currentPct >= this.lastNotifiedPct + 5) {
            this.lastNotifiedPct = currentPct;
            return "+5%";
        }

        return null;
    }

    private normalizeResetTime(t: string | null): string | null {
        if (!t) {
            return null;
        }
        const d = new Date(t);
        if (Number.isNaN(d.getTime())) {
            return t; // fallback to raw string
        }
        // Round to nearest hour - API returns jittery timestamps (17:59:59 vs 18:00:00)
        if (d.getMinutes() >= 30) {
            d.setHours(d.getHours() + 1);
        }
        d.setMinutes(0, 0, 0);
        return d.toISOString().slice(0, 13); // "2026-02-19T18"
    }
}

/**
 * Manages all bucket trackers and notification logic
 */
class UsageWatcher {
    private trackers = new Map<string, BucketTracker>();
    private isFirstPoll = true;

    constructor(private notifications: NotificationConfig) {}

    /**
     * Process usage results and return notifications to send
     */
    processResults(results: AccountUsage[]): Array<{ message: string; reason: string; title: string }> {
        const notifications: Array<{ message: string; reason: string; title: string }> = [];

        for (const account of results) {
            if (!account.usage) {
                continue;
            }

            const limits = normalizeLimits(account.usage);

            for (const limit of limits) {
                if (typeof limit.percent !== "number") {
                    continue;
                }

                const thresholdKey = BUCKET_THRESHOLD_MAP[limit.bucket];
                if (!thresholdKey) {
                    continue;
                }

                const trackerKey = `${account.accountName}:${limit.bucket}:${limit.scope_model ?? ""}`;
                let tracker = this.trackers.get(trackerKey);
                if (!tracker) {
                    tracker = new BucketTracker(account.accountName, limit.bucket);
                    this.trackers.set(trackerKey, tracker);
                }

                const thresholds = this.notifications[thresholdKey];
                const reason = tracker.shouldNotify(
                    limit.percent,
                    limit.resets_at,
                    thresholds,
                    this.isFirstPoll,
                    limit.severity
                );

                if (reason) {
                    notifications.push({
                        message: `${account.accountName}: ${tracker.label} ${Math.round(limit.percent)}%`,
                        reason,
                        title: "Claude Usage Alert",
                    });
                }
            }
        }

        // Mark first poll as done AFTER processing all buckets
        this.isFirstPoll = false;

        return notifications;
    }
}

export async function watchUsage(accountFilter?: string, notifications?: NotificationConfig): Promise<never> {
    if (!notifications) {
        const { loadConfig } = await import("@app/claude/lib/config");
        const config = await loadConfig();
        notifications = config.notifications;
    }

    const watcher = new UsageWatcher(notifications);
    const intervalMs = (notifications.watchInterval || 60) * 1000;

    const cleanup = () => {
        out.println("\nStopping watch mode...");
        process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    while (true) {
        // Watch mode is real-time monitoring: bypass the shared-cache staleness
        // window so each poll triggers a live fetch and threshold alerts fire
        // reliably (the 30s cache window would otherwise serve stale data).
        const results = await getSharedAccountsUsage({ accountFilter, force: true });

        // Clear and render fresh data
        process.stdout.write("\x1B[2J\x1B[H");
        out.println(renderAllAccounts(results));
        out.println(
            `\n${new Date().toLocaleTimeString()} — refreshing every ${notifications.watchInterval}s (Ctrl+C to stop)`
        );

        // Process and get notifications
        const pending = watcher.processResults(results);

        // Send notifications (fire and forget)
        if (pending.length > 0) {
            const criticalNotifs = pending.filter((n) => n.reason === "CRITICAL");
            const warningNotifs = pending.filter((n) => n.reason === "WARNING");
            const initNotifs = pending.filter((n) => n.reason === "INIT");
            const increaseNotifs = pending.filter((n) => n.reason === "+5%");

            for (const notif of criticalNotifs) {
                dispatchNotification({
                    app: "claude",
                    title: notif.title,
                    message: `[CRITICAL] ${notif.message}`,
                });
            }

            for (const notif of warningNotifs) {
                dispatchNotification({
                    app: "claude",
                    title: notif.title,
                    message: `[WARNING] ${notif.message}`,
                });
            }

            for (const notif of initNotifs) {
                dispatchNotification({
                    app: "claude",
                    title: notif.title,
                    message: `[INIT] ${notif.message}`,
                });
            }

            if (increaseNotifs.length > 0) {
                const first = increaseNotifs[0];
                dispatchNotification({
                    app: "claude",
                    title: first.title,
                    message:
                        increaseNotifs.length > 1
                            ? `[+5%] ${first.message} (+${increaseNotifs.length - 1} more)`
                            : `[+5%] ${first.message}`,
                });
            }
        }

        await Bun.sleep(intervalMs);
    }
}
