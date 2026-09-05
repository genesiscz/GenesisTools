import { processExtraUsageNotifications } from "@app/claude/lib/usage/extra-usage-notify";
import { snapshotToAccountUsage } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage";
import { loadDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { NotificationManager } from "@genesiscz/utils/ai/usage-poll/notifications";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import { logger, out } from "@genesiscz/utils/logger";

const ANTHROPIC_SUB = "anthropic-sub";

/**
 * Every window worth a threshold notification, flattened out of a round.
 *
 * Stale snapshots replay an older fetch and error rows carry nothing, so both are skipped:
 * notifying on a replay re-fires a threshold that was already handled once.
 */
export function notifiableWindows(snapshots: readonly AccountUsageSnapshot[]) {
    const out: Array<{
        accountName: string;
        key: string;
        kind: AccountUsageSnapshot["limits"][number]["kind"];
        label: string;
        utilization: number;
        resetsAt: string | null;
    }> = [];

    for (const snapshot of snapshots) {
        if (snapshot.stale || snapshot.error) {
            continue;
        }

        for (const window of snapshot.limits) {
            if (typeof window.percentUsed !== "number" || !Number.isFinite(window.percentUsed)) {
                continue;
            }

            out.push({
                accountName: snapshot.accountName,
                key: window.key,
                kind: window.kind,
                label: window.label,
                utilization: window.percentUsed,
                resetsAt: window.resetsAt ?? null,
            });
        }
    }

    return out;
}

/**
 * Anthropic rows in the shape the claude-only consumers still take: the extra-usage
 * notifier and the warmup rules, neither of which is provider-neutral.
 */
export function anthropicRows(snapshots: readonly AccountUsageSnapshot[]) {
    return snapshots.filter((s) => s.provider === ANTHROPIC_SUB).map(snapshotToAccountUsage);
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    logger.info("[ai-usage] daemon poll starting");

    const dashConfig = await loadDashboardConfig();
    const db = new UsageLimitsDb();
    const notifManager = new NotificationManager(dashConfig.notifications);
    const storage = usagePollStorage();

    await storage.ensureDirs();
    await notifManager.loadState(storage);

    try {
        // `force: true` — the daemon is the every-minute driver, so every other consumer
        // reads its cache for free. Per-provider floors (`usage.minIntervalMs`) still
        // apply inside the shared cache, which is why codex and grok are not refetched on
        // every tick even under force.
        const snapshots = await pollAccounts({ force: true });

        if (snapshots.length === 0) {
            logger.warn("[ai-usage] daemon poll found no configured accounts");
            out.error("No accounts configured. Run: tools claude login");
            process.exit(1);
        }

        for (const window of notifiableWindows(snapshots)) {
            try {
                await notifManager.processUsage(window);
            } catch (err) {
                logger.warn({ err, account: window.accountName, key: window.key }, "[ai-usage] notification failed");
            }
        }

        notifManager.markFirstPollDone();

        try {
            await notifManager.saveState(storage);
        } catch (err) {
            logger.warn({ err }, "[ai-usage] notification state save failed");
        }

        const anthropic = anthropicRows(snapshots);

        // Extra-usage (the paid overflow credit) has its own tracker and its own message,
        // and it is anthropic-only: no other provider reports a spend cap on the usage
        // endpoint. It runs here rather than inside the poll core so `src/utils` keeps no
        // dependency on the claude config.
        try {
            await processExtraUsageNotifications(anthropic.filter((row) => !row.stale));
        } catch (err) {
            logger.warn({ err }, "[ai-usage] extra-usage notification pass failed");
        }

        try {
            const { processWarmupRules } = await import("@app/claude/lib/warmup/service");
            await processWarmupRules(anthropic.filter((row) => !row.stale));
        } catch (err) {
            out.warn(`Warmup check failed: ${err}`);
        }

        db.pruneOlderThan(dashConfig.dataRetentionDays);

        const errorCount = snapshots.filter((s) => s.error).length;
        logger.info(
            { accounts: snapshots.length, errorCount, duration_ms: Date.now() - startedAt },
            "[ai-usage] daemon poll completed"
        );
        out.println(`Polled ${snapshots.length} account(s)${errorCount > 0 ? ` (${errorCount} error(s))` : ""}`);

        for (const snapshot of snapshots) {
            const status = snapshot.error ?? snapshot.stale?.reason ?? "ok";
            out.println(`  ${snapshot.provider}/${snapshot.accountName}: ${status}${snapshot.stale ? " [stale]" : ""}`);
        }
    } finally {
        db.close();
    }
}

if (import.meta.main) {
    try {
        await main();
        process.exit(0);
    } catch (err) {
        logger.error({ error: err }, "[ai-usage] daemon poll failed");
        out.error(err);
        process.exit(1);
    }
}
