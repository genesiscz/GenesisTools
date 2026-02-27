import { sendNotification } from "@app/utils/macos/notifications";
import type { UsageDashboardConfig } from "./dashboard-config";
import { BUCKET_LABELS, BUCKET_THRESHOLD_MAP } from "./constants";

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

    shouldNotify(
        currentPct: number,
        resetAt: string | null,
        thresholds: number[],
        isFirstPoll: boolean
    ): boolean {
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

    processUsage(
        accountName: string,
        bucket: string,
        utilization: number,
        resetsAt: string | null
    ): void {
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

    autoDismissOld(): void {
        const cutoff = Date.now() - 120_000;
        for (const alert of this._alerts) {
            if (!alert.dismissed && alert.timestamp.getTime() < cutoff) {
                alert.dismissed = true;
            }
        }
    }
}
