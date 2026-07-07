import { isUsageBucket } from "@app/claude/lib/usage/api";
import { loadDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import { getSharedAccountsUsage, recordAll } from "@app/claude/lib/usage/shared-cache";
import { logger, out } from "@app/logger";
import { Storage } from "@app/utils/storage/storage";

async function main(): Promise<void> {
    const startedAt = Date.now();
    logger.info("[claude-usage] daemon poll starting");

    const dashConfig = await loadDashboardConfig();

    const db = new UsageHistoryDb();
    const notifManager = new NotificationManager(dashConfig.notifications);
    const storage = new Storage("claude-usage");

    await storage.ensureDirs();
    await notifManager.loadState(storage);

    try {
        // force:true → poll-daemon stays the every-1-min source of truth; the
        // shared accessor refreshes the cache so consumers in the next 30s read
        // free. History writes are owned here (recordAll) — other consumers do
        // not touch the DB.
        const results = await getSharedAccountsUsage({ force: true });

        if (results.length === 0) {
            logger.warn("[claude-usage] daemon poll found no configured accounts");
            out.error("No accounts configured. Run: tools claude login");
            process.exit(1);
        }

        try {
            recordAll(results);
        } catch (err) {
            logger.warn({ err }, "[claude-usage] history record failed; continuing");
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
                    await notifManager.processUsage(account.accountName, bucket, data.utilization, data.resets_at);
                } catch (err) {
                    logger.warn(
                        { err, account: account.accountName, bucket },
                        "[claude-usage] usage notification failed"
                    );
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
            "[claude-usage] daemon poll completed"
        );
        out.println(
            `Polled ${results.length} account(s): ${accountNames}${errorCount > 0 ? ` (${errorCount} error(s))` : ""}`
        );
    } finally {
        db.close();
    }
}

if (import.meta.main) {
    try {
        await main();
        process.exit(0);
    } catch (err) {
        logger.error({ error: err }, "[claude-usage] daemon poll failed");
        out.error(err);
        process.exit(1);
    }
}
