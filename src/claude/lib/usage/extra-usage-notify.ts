import { loadConfig } from "@app/claude/lib/config";
import { logger } from "@app/logger";
import { dispatchNotification } from "@app/utils/notifications";
import type { Storage } from "@app/utils/storage/storage";
import type { AccountUsage } from "./api";
import {
    EXTRA_USAGE_BUCKET,
    EXTRA_USAGE_NOTIFICATION_GROUP,
    ExtraUsageBucketTracker,
    type ExtraUsageNotifyEvent,
    type ExtraUsageTrackerState,
    formatExtraUsageMessage,
} from "./extra-usage-tracker";
import { getClaudeUsageStorage } from "./storage";

const TRACKER_CONFIG_KEY = "notificationPollTracker";

interface PendingExtraUsageNotification {
    accountName: string;
    event: ExtraUsageNotifyEvent;
}

function trackerKey(accountName: string): string {
    return `${accountName}:${EXTRA_USAGE_BUCKET}`;
}

function loadTrackers(saved: Record<string, unknown> | null | undefined): Map<string, ExtraUsageBucketTracker> {
    const trackers = new Map<string, ExtraUsageBucketTracker>();
    const raw = saved?.[TRACKER_CONFIG_KEY] as
        | { extraUsageTrackers?: Record<string, ExtraUsageTrackerState> }
        | undefined;
    const byKey = raw?.extraUsageTrackers ?? {};

    for (const [key, state] of Object.entries(byKey)) {
        const tracker = new ExtraUsageBucketTracker();
        tracker.restoreState(state);
        trackers.set(key, tracker);
    }

    return trackers;
}

function snapshotTrackers(trackers: Map<string, ExtraUsageBucketTracker>): Record<string, ExtraUsageTrackerState> {
    return Object.fromEntries([...trackers.entries()].map(([key, tracker]) => [key, tracker.getState()]));
}

interface ExtraUsageNotifyDeps {
    extraUsageEnabled: () => boolean | Promise<boolean>;
    storage: Storage;
    dispatch: (accountName: string, event: ExtraUsageNotifyEvent) => Promise<void>;
}

export function __makeExtraUsageNotifier(deps: ExtraUsageNotifyDeps) {
    return async function processExtraUsageNotifications(accounts: AccountUsage[]): Promise<void> {
        if (!(await deps.extraUsageEnabled())) {
            return;
        }

        await deps.storage.ensureDirs();

        const pending: PendingExtraUsageNotification[] = [];

        await deps.storage.atomicConfigUpdate<Record<string, unknown>>((config) => {
            const trackers = loadTrackers(config);

            for (const account of accounts) {
                const extraUsage = account.usage?.extra_usage;

                if (!extraUsage) {
                    continue;
                }

                const key = trackerKey(account.accountName);
                let tracker = trackers.get(key);

                if (!tracker) {
                    tracker = new ExtraUsageBucketTracker();
                    trackers.set(key, tracker);
                }

                const event = tracker.shouldNotify(extraUsage);

                if (event) {
                    pending.push({ accountName: account.accountName, event });
                }
            }

            const prev = config[TRACKER_CONFIG_KEY] as Record<string, unknown> | undefined;

            config[TRACKER_CONFIG_KEY] = {
                ...(typeof prev === "object" && prev !== null ? prev : {}),
                extraUsageTrackers: snapshotTrackers(trackers),
                savedAt: new Date().toISOString(),
            };
        });

        for (const { accountName, event } of pending) {
            await deps.dispatch(accountName, event);
        }
    };
}

const processExtraUsageNotifications = __makeExtraUsageNotifier({
    extraUsageEnabled: async () => (await loadConfig()).notifications.extraUsage ?? false,
    storage: getClaudeUsageStorage(),
    dispatch: dispatchExtraUsageNotification,
});

export { processExtraUsageNotifications };

async function dispatchExtraUsageNotification(accountName: string, notifyEvent: ExtraUsageNotifyEvent): Promise<void> {
    const message = formatExtraUsageMessage({ accountName, event: notifyEvent });

    const titleByReason: Record<typeof notifyEvent.reason, string> = {
        EXTRA_ENABLED: "Claude Extra Usage Enabled",
        EXTRA_DISABLED: "Claude Extra Usage Disabled",
        EXTRA_SPEND: "Claude Extra Usage Alert",
    };

    logger.info(
        {
            accountName,
            reason: notifyEvent.reason,
            fromSpent: notifyEvent.fromSpent,
            toSpent: notifyEvent.toSpent,
            limit: notifyEvent.limit,
            currency: notifyEvent.currency,
            elapsedMs: notifyEvent.elapsedMs,
        },
        "[claude-usage] extra usage notification"
    );

    try {
        await dispatchNotification({
            app: "claude",
            title: titleByReason[notifyEvent.reason],
            message,
            group: EXTRA_USAGE_NOTIFICATION_GROUP,
            sound: "Hero",
        });

        logger.info(
            { accountName, reason: notifyEvent.reason, message },
            "[claude-usage] extra usage notification dispatched"
        );
    } catch (err) {
        logger.warn({ err, accountName, reason: notifyEvent.reason }, "[claude-usage] extra usage notification failed");
    }
}
