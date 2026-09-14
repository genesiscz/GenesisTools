import type { LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { UsageDashboardConfig } from "./dashboard-config";

/** Persisted by the claude extra-usage tracker in the same config blob; opaque here. */
type ExtraUsageTrackerState = unknown;

/**
 * Which notification threshold list a window uses, keyed by `LimitWindow.kind` rather than
 * by the claude bucket names the manager used before (spec section 6.1). A kind with no
 * entry simply does not notify: a codex `primary` window maps to `session`, a grok `credit`
 * window maps to nothing, which is intended — credit balance is money, not a rate limit.
 */
const KIND_THRESHOLD_MAP: Partial<Record<LimitKind, "session" | "weekly">> = {
    session: "session",
    weekly: "weekly",
    scoped: "weekly",
    monthly: "weekly",
};

export interface UsageWindowNotification {
    /**
     * `AccountEntry.id`, the immutable one. The tracker is keyed on it because
     * `AiConfigStore` permits duplicate names on purpose: two same-named codex
     * accounts used to share one threshold tracker, so one suppressed the
     * other's alert and their different reset times reset each other's state
     * (PR #368 review t4).
     */
    accountId: string;
    /** Display only. Never a key. */
    accountName: string;
    /** `LimitWindow.key`; the tracker is keyed on it. */
    key: string;
    kind: LimitKind;
    /** `LimitWindow.label`, shown in the message. */
    label?: string;
    utilization: number;
    resetsAt: string | null;
}

const NOTIFICATION_POLL_TRACKER_CONFIG_KEY = "notificationPollTracker";

/**
 * Where the tracker lived before the poll core moved to `Storage("ai-usage")`
 * (spec section 6.3). It is read once, only while the new store still has no trackers.
 *
 * Without it the first poll after the move finds nothing, treats itself as the first poll
 * ever, and fires a desktop banner for every window already over a threshold — one burst
 * per account per window, for thresholds that had all been notified days earlier. The
 * dashboard preferences got a one-time copy for the same reason; this state did not.
 */
const LEGACY_TRACKER_TOOL_NAME = "claude-usage";

interface TrackerState {
    lastNotifiedThreshold: number | null;
    lastResetEpoch: number | null;
}

interface PersistedState {
    trackers: Record<string, TrackerState>;
    extraUsageTrackers?: Record<string, ExtraUsageTrackerState>;
    savedAt: string;
}

type CacheStatus = "HOT" | "COOLING" | "CRITICAL" | "COLD";

interface CacheSessionRow {
    sessionId: string;
    title: string | null;
    cwdShort: string;
    mtime: number;
    lastCacheAt: number;
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

    restoreState(threshold: number | null, resetEpoch: number | null): void {
        this.lastNotifiedThreshold = threshold;
        this.lastResetEpoch = resetEpoch;
    }

    getState(): TrackerState {
        return {
            lastNotifiedThreshold: this.lastNotifiedThreshold,
            lastResetEpoch: this.lastResetEpoch,
        };
    }

    shouldNotify(currentPct: number, resetAt: string | null, thresholds: number[], isFirstPoll: boolean): boolean {
        // `resetsAt` is a raw provider string, forwarded unvalidated by both grok and
        // anthropic. `new Date(bad).getTime()` is NaN, and `NaN !== null`, so one bad poll
        // used to replace the last known reset time with NaN; every later comparison against
        // it was `NaN > 600000`, which is false, and the rollover detector never fired again
        // for that bucket. The state is persisted, so the damage outlived the process.
        const parsed = resetAt ? Date.parse(resetAt) : null;
        const resetEpoch = parsed !== null && Number.isFinite(parsed) ? parsed : null;

        if (
            this.lastResetEpoch !== null &&
            resetEpoch !== null &&
            Math.abs(resetEpoch - this.lastResetEpoch) > 10 * 60 * 1000
        ) {
            this.lastNotifiedThreshold = null;
        }

        // Only a reading we could actually make replaces the stored one. A poll that carried
        // nothing usable leaves the last good reset time in place, so the NEXT good one is
        // still compared against a real instant.
        if (resetEpoch !== null || resetAt === null) {
            this.lastResetEpoch = resetEpoch;
        }

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

async function readTrackerState(storage: Storage): Promise<PersistedState | undefined> {
    const config = await storage.getConfig<Record<string, unknown>>();

    return config?.[NOTIFICATION_POLL_TRACKER_CONFIG_KEY] as PersistedState | undefined;
}

export class NotificationManager {
    private trackers = new Map<string, BucketTracker>();
    private isFirstPoll = true;
    private dirty = false;
    private _alerts: UsageAlert[] = [];
    private alertIdCounter = 0;

    constructor(private config: UsageDashboardConfig["notifications"]) {}

    get alerts(): UsageAlert[] {
        return this._alerts.filter((a) => !a.dismissed);
    }

    async processUsage(window: UsageWindowNotification): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        const thresholdKey = KIND_THRESHOLD_MAP[window.kind];
        if (!thresholdKey) {
            return;
        }

        const { accountId, accountName, key, utilization, resetsAt } = window;
        const trackerKey = `${accountId}:${key}`;
        let tracker = this.trackers.get(trackerKey) ?? this.adoptLegacyTracker(accountName, key, trackerKey);

        if (!tracker) {
            tracker = new BucketTracker(accountId, key);
            this.trackers.set(trackerKey, tracker);
        }

        const thresholds = this.config.thresholds[thresholdKey];
        const shouldNotify = tracker.shouldNotify(utilization, resetsAt, thresholds, this.isFirstPoll);

        if (shouldNotify) {
            this.dirty = true;
            const label = window.label ?? key;
            const severity = utilization >= 80 ? "critical" : "warning";
            const message = `${accountName}: ${label} ${Math.round(utilization)}%`;

            if (this.config.inTui) {
                this._alerts.push({
                    id: `alert-${++this.alertIdCounter}`,
                    accountName,
                    bucket: key,
                    utilization,
                    message,
                    severity,
                    timestamp: new Date(),
                    dismissed: false,
                });
            }

            await this.dispatchDesktop({ title: "AI Usage Alert", message, group: "ai-usage" });
        }
    }

    /**
     * Carry a `name:key` tracker over to its `id:key` home, once.
     *
     * Without it the first poll after this change finds nothing under the new key,
     * treats every window as never-notified and fires a banner for each one that is
     * already over a threshold — the same burst the legacy-store read above exists
     * to prevent. Two accounts sharing a name cannot both adopt: the first takes the
     * state and removes it, and the second starts clean, which is the correct
     * outcome for a tracker that never distinguished them.
     */
    private adoptLegacyTracker(accountName: string, key: string, trackerKey: string): BucketTracker | undefined {
        const legacyKey = `${accountName}:${key}`;
        const legacy = this.trackers.get(legacyKey);

        if (!legacy || legacyKey === trackerKey) {
            return undefined;
        }

        this.trackers.delete(legacyKey);
        this.trackers.set(trackerKey, legacy);
        this.dirty = true;
        logger.debug({ legacyKey, trackerKey }, "[usage] re-keyed a notification tracker onto the account id");

        return legacy;
    }

    /**
     * The one desktop-notification door. `macos: false` means the user asked for no
     * banner, and the system channel is enabled by default, so the switch has to be
     * honoured here rather than left to the channel config. `sound` is the dashboard's
     * own preference and outranks the global channel sound.
     */
    private async dispatchDesktop(event: { title: string; message: string; group?: string }): Promise<void> {
        if (!this.config.macos) {
            return;
        }

        await dispatchNotification({
            app: "claude",
            ...event,
            ...(this.config.sound ? { sound: this.config.sound } : {}),
        });
    }

    markFirstPollDone(): void {
        this.isFirstPoll = false;
    }

    async loadState(storage: Storage): Promise<void> {
        const saved = await readTrackerState(storage);

        if (saved?.trackers) {
            this.applyPersistedTrackers(saved.trackers);
            return;
        }

        const legacy = await readTrackerState(new Storage(LEGACY_TRACKER_TOOL_NAME));

        if (!legacy?.trackers) {
            return;
        }

        logger.debug({ from: LEGACY_TRACKER_TOOL_NAME }, "[usage] restored notification thresholds from the old store");
        this.applyPersistedTrackers(legacy.trackers);
    }

    private applyPersistedTrackers(byKey: Record<string, TrackerState>): void {
        for (const [key, ts] of Object.entries(byKey)) {
            const [accountName, bucketName] = key.split(":");
            if (!accountName || !bucketName) {
                continue;
            }
            const t = new BucketTracker(accountName, bucketName);
            t.restoreState(ts.lastNotifiedThreshold, ts.lastResetEpoch);
            this.trackers.set(key, t);
        }

        if (this.trackers.size > 0) {
            this.isFirstPoll = false;
        }
    }

    async saveState(storage: Storage): Promise<void> {
        if (!this.dirty) {
            return;
        }

        const snapshot = Object.fromEntries([...this.trackers.entries()].map(([k, t]) => [k, t.getState()]));
        await storage.atomicConfigUpdate<Record<string, unknown>>((c) => {
            const prev = c[NOTIFICATION_POLL_TRACKER_CONFIG_KEY] as PersistedState | undefined;

            c[NOTIFICATION_POLL_TRACKER_CONFIG_KEY] = {
                trackers: snapshot,
                extraUsageTrackers: prev?.extraUsageTrackers,
                savedAt: new Date().toISOString(),
            };
        });
        this.dirty = false;
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
    private cacheTrackers = new Map<string, { lastThreshold: number | null; lastCacheAt: number }>();

    processCacheSessions(sessions: CacheSessionRow[]): void {
        if (!this.config.enabled) {
            return;
        }

        const now = Date.now();

        for (const session of sessions) {
            const key = session.sessionId;
            let tracker = this.cacheTrackers.get(key);

            // Reset only when the cache clock moves. A metadata rewrite
            // changes mtime while lastCacheAt (and HOT/COOLING/CRITICAL) stay put.
            if (tracker && tracker.lastCacheAt !== session.lastCacheAt) {
                tracker = undefined;
                this.cacheTrackers.delete(key);
            }

            if (!tracker) {
                tracker = { lastThreshold: null, lastCacheAt: session.lastCacheAt };
                this.cacheTrackers.set(key, tracker);
            }

            const status: CacheStatus = session.cacheStatus;
            const sessionLabel = session.title?.slice(0, 40) ?? session.sessionId.slice(0, 8);
            const projectLabel = session.cwdShort;

            if (status === "COOLING" && tracker.lastThreshold === null) {
                tracker.lastThreshold = 10;
                tracker.lastCacheAt = session.lastCacheAt;

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

                void this.dispatchDesktop({ title: "Claude Cache Cooling", message });
            } else if (status === "CRITICAL" && (tracker.lastThreshold === null || tracker.lastThreshold < 5)) {
                tracker.lastThreshold = 5;
                tracker.lastCacheAt = session.lastCacheAt;

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

                void this.dispatchDesktop({ title: "Claude Cache Critical", message });
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
