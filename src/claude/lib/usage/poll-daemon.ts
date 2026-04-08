import { fetchAllAccountsUsage } from "@app/claude/lib/usage/api";
import { loadDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { NotificationManager } from "@app/claude/lib/usage/notification-manager";
import { Storage } from "@app/utils/storage/storage";

async function main(): Promise<void> {
    const dashConfig = await loadDashboardConfig();

    const db = new UsageHistoryDb();
    const notifManager = new NotificationManager(dashConfig.notifications);
    const storage = new Storage("claude-usage");

    await storage.ensureDirs();
    await notifManager.loadState(storage);

    try {
        const results = await fetchAllAccountsUsage();

        if (results.length === 0) {
            console.error("No accounts configured. Run: tools claude login");
            process.exit(1);
        }

        for (const account of results) {
            if (!account.usage) {
                continue;
            }

            for (const [bucket, data] of Object.entries(account.usage)) {
                if (!data || typeof data !== "object" || !("utilization" in data)) {
                    continue;
                }

                if (data.utilization === null || data.utilization === undefined) {
                    continue;
                }

                db.recordIfChanged(account.accountName, bucket, data.utilization, data.resets_at);

                try {
                    notifManager.processUsage(account.accountName, bucket, data.utilization, data.resets_at);
                } catch {
                    // Notification failure should not interrupt polling
                }
            }
        }

        notifManager.markFirstPollDone();

        try {
            await notifManager.saveState(storage);
        } catch {
            // Persistence failure should not fail the poll
        }

        // Warmup hook: check rules against fresh usage data
        try {
            const { processWarmupRules } = await import("@app/claude/lib/warmup/service");
            await processWarmupRules(results);
        } catch (err) {
            console.warn(`Warmup check failed: ${err}`);
        }

        db.pruneOlderThan(dashConfig.dataRetentionDays);

        const accountNames = results.map((r) => r.accountName).join(", ");
        const errorCount = results.filter((r) => r.error).length;
        console.log(
            `Polled ${results.length} account(s): ${accountNames}${errorCount > 0 ? ` (${errorCount} error(s))` : ""}`
        );
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
