import type { AccountConfig } from "../config";
import type { NotificationConfig } from "../config";
import { fetchAllAccountsUsage, type AccountUsage } from "./api";
import { renderAllAccounts } from "./display";
import { sendNotification } from "@app/utils/macos/notifications";

const BUCKET_THRESHOLD_MAP: Record<string, "sessionThresholds" | "weeklyThresholds"> = {
	five_hour: "sessionThresholds",
	seven_day: "weeklyThresholds",
	seven_day_opus: "weeklyThresholds",
	seven_day_sonnet: "weeklyThresholds",
	seven_day_oauth_apps: "weeklyThresholds",
};

/**
 * Tracks notification state for a single bucket (e.g., "Livinka:seven_day")
 */
class BucketTracker {
	private lastNotifiedPct: number | null = null;
	private lastResetAt: string | null = null;

	constructor(
		public readonly accountName: string,
		public readonly bucketName: string,
	) {}

	get key(): string {
		return `${this.accountName}:${this.bucketName}`;
	}

	get label(): string {
		return this.bucketName === "five_hour" ? "Session" : this.bucketName.replace(/_/g, " ");
	}

	/**
	 * Check if we should notify for this bucket.
	 * Returns notification reason or null if no notification needed.
	 */
	shouldNotify(
		currentPct: number,
		resetAt: string | null,
		thresholds: number[],
		isFirstPoll: boolean,
	): "INIT" | "+5%" | null {
		const normalizedReset = this.normalizeResetTime(resetAt);

		// Period reset detection - clear state if reset timestamp changed
		if (this.lastResetAt !== null && this.lastResetAt !== normalizedReset) {
			this.lastNotifiedPct = null;
		}
		this.lastResetAt = normalizedReset;

		// Check if any threshold is crossed
		const crossedThreshold = thresholds.some((t) => currentPct >= t);
		if (!crossedThreshold) {
			return null;
		}

		// First poll: always notify if threshold crossed
		if (isFirstPoll) {
			this.lastNotifiedPct = currentPct;
			return "INIT";
		}

		// Never notified before (new bucket mid-session): notify
		if (this.lastNotifiedPct === null) {
			this.lastNotifiedPct = currentPct;
			return "INIT";
		}

		// Subsequent: only notify if 5% increase
		if (currentPct >= this.lastNotifiedPct + 5) {
			this.lastNotifiedPct = currentPct;
			return "+5%";
		}

		return null;
	}

	private normalizeResetTime(t: string | null): string | null {
		if (!t) return null;
		// Round to nearest hour - API returns jittery timestamps (17:59:59 vs 18:00:00)
		const d = new Date(t);
		if (d.getMinutes() >= 30) {
			d.setHours(d.getHours() + 1);
		}
		d.setMinutes(0, 0, 0);
		return d.toISOString().slice(0, 13); // "2026-02-19T18"
	}
}

/**
 * Manages all bucket trackers and notification logic
 */
class UsageWatcher {
	private trackers = new Map<string, BucketTracker>();
	private isFirstPoll = true;

	constructor(private notifications: NotificationConfig) {}

	/**
	 * Process usage results and return notifications to send
	 */
	processResults(results: AccountUsage[]): Array<{ message: string; reason: string }> {
		const notifications: Array<{ message: string; reason: string }> = [];

		for (const account of results) {
			if (!account.usage) continue;

			for (const [bucket, data] of Object.entries(account.usage)) {
				if (!data || typeof data !== "object" || !("utilization" in data)) continue;
				if (data.utilization === null || data.utilization === undefined) continue;

				const thresholdKey = BUCKET_THRESHOLD_MAP[bucket];
				if (!thresholdKey) continue;

				// Get or create tracker
				const trackerKey = `${account.accountName}:${bucket}`;
				let tracker = this.trackers.get(trackerKey);
				if (!tracker) {
					tracker = new BucketTracker(account.accountName, bucket);
					this.trackers.set(trackerKey, tracker);
				}

				// Check if notification needed
				const thresholds = this.notifications[thresholdKey];
				const reason = tracker.shouldNotify(
					data.utilization,
					data.resets_at,
					thresholds,
					this.isFirstPoll,
				);

				if (reason) {
					notifications.push({
						message: `${account.accountName}: ${tracker.label} ${Math.round(data.utilization)}%`,
						reason,
					});
				}
			}
		}

		// Mark first poll as done AFTER processing all buckets
		this.isFirstPoll = false;

		return notifications;
	}
}

export async function watchUsage(
	accounts: Record<string, AccountConfig>,
	notifications: NotificationConfig,
): Promise<never> {
	const watcher = new UsageWatcher(notifications);
	const intervalMs = (notifications.watchInterval || 60) * 1000;

	while (true) {
		// Fetch while showing old data, then clear and render
		const results = await fetchAllAccountsUsage(accounts);

		// Clear and render fresh data
		process.stdout.write("\x1B[2J\x1B[H");
		console.log(renderAllAccounts(results));
		console.log(
			`\n${new Date().toLocaleTimeString()} — refreshing every ${notifications.watchInterval}s (Ctrl+C to stop)`,
		);

		// Process and get notifications
		const pending = watcher.processResults(results);

		// Send notifications (fire and forget)
		if (pending.length > 0 && notifications.channels.macos) {
			const initNotifs = pending.filter((n) => n.reason === "INIT");
			const increaseNotifs = pending.filter((n) => n.reason === "+5%");

			// INIT: send each notification individually so user sees all warnings
			for (const notif of initNotifs) {
				sendNotification({
					title: "Claude Usage Alert",
					message: `[INIT] ${notif.message}`,
					sound: "Purr",
				});
			}

			// +5%: batch these to avoid spam during normal operation
			if (increaseNotifs.length > 0) {
				const first = increaseNotifs[0];
				sendNotification({
					title: "Claude Usage Alert",
					message:
						increaseNotifs.length > 1
							? `[+5%] ${first.message} (+${increaseNotifs.length - 1} more)`
							: `[+5%] ${first.message}`,
					sound: "Purr",
				});
			}
		}

		await Bun.sleep(intervalMs);
	}
}
