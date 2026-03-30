import { sendNotification } from "@app/utils/macos/notifications";
import { BUCKET_LABELS, BUCKET_THRESHOLD_MAP } from "./constants";
import type { UsageDashboardConfig } from "./dashboard-config";

type CacheStatus = "HOT" | "COOLING" | "CRITICAL" | "COLD";

interface CacheSessionRow {
    sessionId: string;
    title: string | null;
    cwdShort: string;
    mtime: number;
    cacheStatus: CacheStatus;
}

export interface UsageAlert {
    id: string;
    accountName: string;
    bucket: string;
    utilization: number;
    message: string;
    severity: "warning" | "critical";
    timestamp: Date;
    dismissed: boolean;
}

class BucketTracker {
    private lastNotifiedThreshold: number | null = null;
    private lastResetEpoch: number | null = null;

    constructor(
        public readonly accountName: string,
        public readonly bucketName: string
    ) {}

    shouldNotify(currentPct: number, resetAt: string | null, thresholds: number[], isFirstPoll: boolean): boolean {
        const resetEpoch = resetAt ? new Date(resetAt).getTime() : null;

        if (
            this.lastResetEpoch !== null &&
            resetEpoch !== null &&
            Math.abs(resetEpoch - this.lastResetEpoch) > 10 * 60 * 1000
        ) {
            this.lastNotifiedThreshold = null;
        }

        this.lastResetEpoch = resetEpoch;

        const crossed = thresholds.filter((t) => currentPct >= t);
        if (crossed.length === 0) {
            return false;
        }

        const highest = Math.max(...crossed);

        if (isFirstPoll || this.lastNotifiedThreshold === null) {
            this.lastNotifiedThreshold = highest;
            return true;
        }

        if (highest > this.lastNotifiedThreshold) {
            this.lastNotifiedThreshold = highest;
            return true;
        }

        return false;
    }
}

export class NotificationManager {
    private trackers = new Map<string, BucketTracker>();
    private isFirstPoll = true;
    private _alerts: UsageAlert[] = [];
    private alertIdCounter = 0;

    constructor(private config: UsageDashboardConfig["notifications"]) {}

    get alerts(): UsageAlert[] {
        return this._alerts.filter((a) => !a.dismissed);
    }

    processUsage(accountName: string, bucket: string, utilization: number, resetsAt: string | null): void {
        if (!this.config.enabled) {
            return;
        }

        const thresholdKey = BUCKET_THRESHOLD_MAP[bucket];
        if (!thresholdKey) {
            return;
        }

        const trackerKey = `${accountName}:${bucket}`;
        let tracker = this.trackers.get(trackerKey);
        if (!tracker) {
            tracker = new BucketTracker(accountName, bucket);
            this.trackers.set(trackerKey, tracker);
        }

        const thresholds = this.config.thresholds[thresholdKey];
        const shouldNotify = tracker.shouldNotify(utilization, resetsAt, thresholds, this.isFirstPoll);

        if (shouldNotify) {
            const label = BUCKET_LABELS[bucket] ?? bucket;
            const severity = utilization >= 80 ? "critical" : "warning";
            const message = `${accountName}: ${label} ${Math.round(utilization)}%`;

            if (this.config.inTui) {
                this._alerts.push({
                    id: `alert-${++this.alertIdCounter}`,
                    accountName,
                    bucket,
                    utilization,
                    message,
                    severity,
                    timestamp: new Date(),
                    dismissed: false,
                });
            }

            if (this.config.macos) {
                sendNotification({
                    title: "Claude Usage Alert",
                    message,
                    sound: this.config.sound || "Purr",
                });
            }
        }
    }

    markFirstPollDone(): void {
        this.isFirstPoll = false;
    }

    dismissAlert(alertId: string): void {
        const alert = this._alerts.find((a) => a.id === alertId);
        if (alert) {
            alert.dismissed = true;
        }
    }

    dismissAll(): void {
        for (const alert of this._alerts) {
            alert.dismissed = true;
        }
    }

    // Track which cache thresholds have been notified per session
    private cacheTrackers = new Map<string, { lastThreshold: number | null; lastMtime: number }>();

    processCacheSessions(sessions: CacheSessionRow[]): void {
        if (!this.config.enabled) {
            return;
        }

        const now = Date.now();

        for (const session of sessions) {
            const key = session.sessionId;
            let tracker = this.cacheTrackers.get(key);

            // Reset tracker if session sent a new message (mtime changed = cache refreshed)
            if (tracker && tracker.lastMtime !== session.mtime) {
                tracker = undefined;
                this.cacheTrackers.delete(key);
            }

            if (!tracker) {
                tracker = { lastThreshold: null, lastMtime: session.mtime };
                this.cacheTrackers.set(key, tracker);
            }

            const status: CacheStatus = session.cacheStatus;
            const sessionLabel = session.title?.slice(0, 40) ?? session.sessionId.slice(0, 8);
            const projectLabel = session.cwdShort;

            if (status === "COOLING" && tracker.lastThreshold === null) {
                tracker.lastThreshold = 10;
                tracker.lastMtime = session.mtime;

                const message = `Cache cooling — 10 min left\n${sessionLabel}\n${projectLabel}`;

                if (this.config.inTui) {
                    this._alerts.push({
                        id: `cache-${++this.alertIdCounter}`,
                        accountName: projectLabel,
                        bucket: "cache",
                        utilization: 83, // ~10min left of 60min
                        message,
                        severity: "warning",
                        timestamp: new Date(now),
                        dismissed: false,
                    });
                }

                if (this.config.macos) {
                    sendNotification({
                        title: "Claude Cache Cooling",
                        message,
                        sound: this.config.sound || "Purr",
                    });
                }
            } else if (status === "CRITICAL" && (tracker.lastThreshold === null || tracker.lastThreshold < 5)) {
                tracker.lastThreshold = 5;
                tracker.lastMtime = session.mtime;

                const message = `Cache critical — 5 min left\n${sessionLabel}\n${projectLabel}`;

                if (this.config.inTui) {
                    this._alerts.push({
                        id: `cache-${++this.alertIdCounter}`,
                        accountName: projectLabel,
                        bucket: "cache",
                        utilization: 92, // ~5min left
                        message,
                        severity: "critical",
                        timestamp: new Date(now),
                        dismissed: false,
                    });
                }

                if (this.config.macos) {
                    sendNotification({
                        title: "Claude Cache Critical",
                        message,
                        sound: this.config.sound || "Purr",
                    });
                }
            }
        }
    }

    autoDismissOld(): void {
        const cutoff = Date.now() - 120_000;
        for (const alert of this._alerts) {
            if (!alert.dismissed && alert.timestamp.getTime() < cutoff) {
                alert.dismissed = true;
            }
        }
    }
}
