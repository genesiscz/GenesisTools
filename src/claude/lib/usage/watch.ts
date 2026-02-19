import type { AccountConfig } from "../config";
import type { NotificationConfig } from "../config";
import { fetchAllAccountsUsage } from "./api";
import { renderAllAccounts } from "./display";
import { sendNotification } from "@app/utils/macos/notifications";

const BUCKET_THRESHOLD_MAP: Record<string, "sessionThresholds" | "weeklyThresholds"> = {
	five_hour: "sessionThresholds",
	seven_day: "weeklyThresholds",
	seven_day_opus: "weeklyThresholds",
	seven_day_sonnet: "weeklyThresholds",
	seven_day_oauth_apps: "weeklyThresholds",
};

// Minimum utilization increase (in %) before sending another notification for same bucket
const MIN_NOTIFICATION_GAP = 5;

export async function watchUsage(
	accounts: Record<string, AccountConfig>,
	notifications: NotificationConfig,
): Promise<never> {
	// Track the last utilization we notified about for each bucket
	const lastNotifiedUtilization = new Map<string, number>();
	const lastResetsAt = new Map<string, string | null>();
	const intervalMs = (notifications.watchInterval || 60) * 1000;
	let isFirstPoll = true;

	while (true) {
		// Clear screen
		process.stdout.write("\x1B[2J\x1B[H");

		const results = await fetchAllAccountsUsage(accounts);
		console.log(renderAllAccounts(results));
		console.log(
			`\n${new Date().toLocaleTimeString()} — refreshing every ${notifications.watchInterval}s (Ctrl+C to stop)`,
		);

		// Check thresholds and queue notifications
		const pendingNotifications: Array<{ title: string; message: string }> = [];

		for (const account of results) {
			if (!account.usage) continue;
			for (const [bucket, data] of Object.entries(account.usage)) {
				if (!data || typeof data !== "object" || !("utilization" in data)) continue;
				const thresholdKey = BUCKET_THRESHOLD_MAP[bucket];
				if (!thresholdKey) continue;
				// Skip null/undefined buckets (e.g. seven_day_opus when not using opus)
				if (data.utilization === null || data.utilization === undefined) continue;

				const bucketKey = `${account.accountName}:${bucket}`;
				const utilization = data.utilization;

				// Clear state when the period resets
				const prevReset = lastResetsAt.get(bucketKey);
				if (prevReset !== undefined && prevReset !== data.resets_at) {
					lastNotifiedUtilization.delete(bucketKey);
				}
				lastResetsAt.set(bucketKey, data.resets_at);

				// Find the highest threshold that's been crossed
				const thresholds = notifications[thresholdKey];
				const crossedThreshold = thresholds
					.filter((t) => utilization >= t)
					.sort((a, b) => b - a)[0];

				if (crossedThreshold === undefined) continue;

				// Check if we should notify
				const lastNotified = lastNotifiedUtilization.get(bucketKey);
				const bucketLabel = bucket === "five_hour" ? "Session" : bucket.replace(/_/g, " ");

				if (isFirstPoll) {
					// On first poll, notify about all crossed thresholds, then set baseline
					if (crossedThreshold !== undefined && notifications.channels.macos) {
						pendingNotifications.push({
							title: "Claude Usage Alert",
							message: `${account.accountName}: ${bucketLabel} ${Math.round(utilization)}%`,
						});
					}
					lastNotifiedUtilization.set(bucketKey, utilization);
				} else {
					// Subsequent polls: only notify if utilization increased by at least 5%
					const baseline = lastNotified ?? 0;
					if (utilization >= baseline + MIN_NOTIFICATION_GAP && notifications.channels.macos) {
						lastNotifiedUtilization.set(bucketKey, utilization);
						pendingNotifications.push({
							title: "Claude Usage Alert",
							message: `${account.accountName}: ${bucketLabel} ${Math.round(utilization)}%`,
						});
					}
				}
			}
		}

		isFirstPoll = false;

		// Send notifications asynchronously (don't await, fire and forget)
		if (pendingNotifications.length > 0) {
			// Send all as one batch — don't spam with multiple notifications
			// Just send the first one (highest priority) to avoid notification spam
			const notification = pendingNotifications[0];
			sendNotification({
				title: notification.title,
				message: pendingNotifications.length > 1
					? `${notification.message} (+${pendingNotifications.length - 1} more)`
					: notification.message,
				sound: "Purr",
			}); // No await — async fire and forget
		}

		await Bun.sleep(intervalMs);
	}
}
