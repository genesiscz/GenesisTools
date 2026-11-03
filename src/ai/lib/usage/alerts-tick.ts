import { alertChannels } from "@app/ai/lib/usage/alert-channels";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { runAlertEngine } from "@genesiscz/utils/ai/usage/alerts/engine";
import { seedThresholdAlerts } from "@genesiscz/utils/ai/usage/alerts/legacy-seed";
import { UsageAlertsStore } from "@genesiscz/utils/ai/usage/alerts/log";
import { buildAlertRound } from "@genesiscz/utils/ai/usage/alerts/round";
import type { AlertChannelTable, StoredAlert } from "@genesiscz/utils/ai/usage/alerts/types";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import type { UsageDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import type { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { type NotifiedThreshold, readNotifiedThresholds } from "@genesiscz/utils/ai/usage-poll/notifications";
import { readingSourceOf, usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import type { Storage } from "@genesiscz/utils/storage/storage";

export interface UsageTickResult {
    runs: { extended: number; started: number };
    seeded: number;
    fired: StoredAlert[];
}

/**
 * The daemon tick's new stages (design 2026-11-01, section 7): record the round's poll runs, then run the alert
 * engine over the round. The previous round's end is read before this round is recorded, so the health rule can see
 * a span nobody polled. The events the round judges start at the alert cursor, which moves only after the engine
 * finished: a failed pass leaves its events to the next one (the dedupe keys make the replay safe). Each stage reads
 * only what the round needs, which keeps the tick inside its budget.
 */
export async function recordRoundAndAlert(input: {
    db: UsageLimitsDb;
    snapshots: readonly AccountUsageSnapshot[];
    config: UsageDashboardConfig;
    storage: Storage;
    now?: Date;
    channels?: AlertChannelTable;
    trackers?: () => Promise<Record<string, NotifiedThreshold>>;
}): Promise<UsageTickResult> {
    const now = input.now ?? new Date();
    const connection = input.db.connection();
    const runsStore = new PollRunsStore(connection);
    const previousRoundAt = runsStore.lastRoundAt();
    const plugins = usagePlugins();
    const runs = runsStore.recordRound(
        input.snapshots.map((snapshot) => ({ snapshot, source: readingSourceOf(snapshot, plugins) })),
        now
    );
    const store = new UsageAlertsStore(connection);
    const lastEvaluatedAt = store.lastEvaluatedAt();
    // Every tick: the seed is per window, and a window that could not be read on the first tick still needs it.
    const seeded = seedThresholdAlerts({
        store,
        trackers: await (input.trackers ?? (() => readNotifiedThresholds(input.storage)))(),
        snapshots: input.snapshots,
        settings: input.config.alerts.rules.threshold,
        now,
    });
    const round = buildAlertRound({
        db: connection,
        snapshots: input.snapshots,
        now,
        previousRoundAt,
        lastEvaluatedAt,
        config: input.config.alerts,
        budgets: input.config.budgets,
    });
    const fired = await runAlertEngine({
        round,
        config: input.config.alerts,
        store,
        channels: input.channels ?? alertChannels(input.config.notifications),
    });
    store.markEvaluated(now);

    return { runs, seeded, fired };
}
