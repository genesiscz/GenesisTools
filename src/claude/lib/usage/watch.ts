import type { AccountConfig } from "../config";
import type { NotificationConfig } from "../config";
import { fetchAllAccountsUsage } from "./api";
import { renderAllAccounts } from "./display";
import { sendNotification } from "@app/utils/macos/notifications";

const BUCKET_THRESHOLD_MAP: Record<string, "sessionThresholds" | "weeklyThresholds"> = {
	five_hour: "sessionThresholds",
	seven_day: "weeklyThresholds",
	seven_day_opus: "weeklyThresholds",
};

export async function watchUsage(
	accounts: Record<string, AccountConfig>,
	notifications: NotificationConfig,
): Promise<never> {
	const firedThresholds = new Set<string>();
	const intervalMs = (notifications.watchInterval || 60) * 1000;

	while (true) {
		// Clear screen
		process.stdout.write("\x1B[2J\x1B[H");

		const results = await fetchAllAccountsUsage(accounts);
		console.log(renderAllAccounts(results));
		console.log(
			`\n${new Date().toLocaleTimeString()} — refreshing every ${notifications.watchInterval}s (Ctrl+C to stop)`,
		);

		// Check thresholds
		for (const account of results) {
			if (!account.usage) continue;
			for (const [bucket, data] of Object.entries(account.usage)) {
				if (!data || typeof data !== "object" || !("utilization" in data)) continue;
				const thresholdKey = BUCKET_THRESHOLD_MAP[bucket];
				if (!thresholdKey) continue;
				const thresholds = notifications[thresholdKey];
				for (const threshold of thresholds) {
					const key = `${account.accountName}:${bucket}:${threshold}`;
					if (data.utilization >= threshold && !firedThresholds.has(key)) {
						firedThresholds.add(key);
						if (notifications.channels.macos) {
							sendNotification({
								title: `Claude Usage: ${account.accountName}`,
								message: `${bucket.replace(/_/g, " ")} at ${Math.round(data.utilization)}% (threshold: ${threshold}%)`,
								sound: "Purr",
							});
						}
					}
				}
			}
		}

		await Bun.sleep(intervalMs);
	}
}
