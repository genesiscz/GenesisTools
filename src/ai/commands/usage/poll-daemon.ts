import { isUsageBucket } from "@app/claude/lib/usage/api";
import { BUCKET_LABELS, bucketKind } from "@app/claude/lib/usage/constants";
import { loadDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import { pluginsWithUsage, pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { logger, out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * Providers already polled by the claude-only accessor above. `getSharedAccountsUsage`
 * still owns `snapshots:anthropic-sub`, so polling anthropic through `pollAccounts` in the
 * same run would fetch twice AND write two different payload shapes to one cache key.
 * Plan-Usage phase 3 gives `anthropic-sub` an `accounts.usage`; phase 7 then deletes this
 * set together with the `getSharedAccountsUsage` call above it.
 */
const PROVIDERS_ON_THE_LEGACY_PATH = new Set(["anthropic-sub"]);

/** Every provider whose usage the poll core owns today. Empty until phase 3 lands. */
function coreProviders(): string[] {
    return pluginsWithUsage()
        .map((entry) => entry.plugin.id)
        .filter((id) => !PROVIDERS_ON_THE_LEGACY_PATH.has(id));
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    logger.info("[ai-usage] daemon poll starting");

    const dashConfig = await loadDashboardConfig();

    const db = new UsageHistoryDb();
    const notifManager = new NotificationManager(dashConfig.notifications);
    const storage = new Storage("claude-usage");

    await storage.ensureDirs();
    await notifManager.loadState(storage);

    try {
        // force:true → poll-daemon stays the every-1-min source of truth; the
        // shared accessor refreshes the cache so consumers in the next 30s read
        // free. History rows are written by the accessor's write-through
        // (recordHistory → recordAll) on every live fetch, whichever consumer
        // wins it — the daemon no longer records separately.
        const results = await getSharedAccountsUsage({ force: true });

        if (results.length === 0) {
            logger.warn("[ai-usage] daemon poll found no configured accounts");
            out.error("No accounts configured. Run: tools claude login");
            process.exit(1);
        }

        for (const account of results) {
            // Stale entries replay an older fetch — feeding them to the
            // notification manager could re-fire thresholds after a restart.
            if (!account.usage || account.stale) {
                continue;
            }

            for (const [bucket, data] of Object.entries(account.usage)) {
                if (!isUsageBucket(data)) {
                    continue;
                }

                if (data.utilization === null || data.utilization === undefined) {
                    continue;
                }

                try {
                    await notifManager.processUsage({
                        accountName: account.accountName,
                        key: bucket,
                        kind: bucketKind(bucket),
                        label: BUCKET_LABELS[bucket] ?? bucket,
                        utilization: data.utilization,
                        resetsAt: data.resets_at,
                    });
                } catch (err) {
                    logger.warn({ err, account: account.accountName, bucket }, "[ai-usage] usage notification failed");
                }
            }
        }

        notifManager.markFirstPollDone();

        try {
            await notifManager.saveState(storage);
        } catch {
            // Persistence failure should not fail the poll
        }

        // Warmup hook: check rules against fresh usage data (stale replays excluded)
        try {
            const { processWarmupRules } = await import("@app/claude/lib/warmup/service");
            await processWarmupRules(results.filter((r) => !r.stale));
        } catch (err) {
            out.warn(`Warmup check failed: ${err}`);
        }

        db.pruneOlderThan(dashConfig.dataRetentionDays);

        const accountNames = results.map((r) => r.accountName).join(", ");
        const errorCount = results.filter((r) => r.error).length;
        logger.info(
            { accounts: results.length, accountNames, errorCount, duration_ms: Date.now() - startedAt },
            "[ai-usage] daemon poll completed"
        );
        out.println(
            `Polled ${results.length} account(s): ${accountNames}${errorCount > 0 ? ` (${errorCount} error(s))` : ""}`
        );

        for (const account of results) {
            const status = account.error ?? account.stale?.reason ?? "ok";
            out.println(`  ${account.accountName}: ${status}${account.stale ? " [stale]" : ""}`);
        }

        // Every other provider goes through the poll core, which enforces its own
        // per-provider floor (`AccountFeatures.usage.minIntervalMs`, default 30s for
        // anthropic, 120s for codex, 300s for grok) inside the shared cache. `force` is
        // deliberately NOT set here: the daemon ticks faster than those floors.
        const providers = coreProviders();

        if (providers.length > 0) {
            const snapshots = await pollAccounts({ providers });
            const failed = snapshots.filter((s) => s.error).length;
            logger.info({ providers, snapshots: snapshots.length, failed }, "[ai-usage] provider poll completed");

            for (const snapshot of snapshots) {
                const status = snapshot.error ?? snapshot.stale?.reason ?? "ok";
                out.println(`  ${snapshot.provider}/${snapshot.accountName}: ${status}`);
            }
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
