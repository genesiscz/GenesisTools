/**
 * `NotificationManager` moved to `@genesiscz/utils/ai/usage-poll/notifications`, where its
 * thresholds are keyed by `LimitWindow.kind` instead of the claude bucket names
 * (spec 2026-09-04 section 6.1).
 */
export {
    NotificationManager,
    type UsageAlert,
    type UsageWindowNotification,
} from "@genesiscz/utils/ai/usage-poll/notifications";
