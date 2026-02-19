import pc from "picocolors";
import type { AccountUsage } from "./api";

const BAR_WIDTH = 40;
const BLOCK_FULL = "\u2588"; // █
const BLOCK_HALF = "\u258C"; // ▌

const BUCKET_PERIODS_MS: Record<string, number> = {
	five_hour: 5 * 60 * 60 * 1000,
	seven_day: 7 * 24 * 60 * 60 * 1000,
	seven_day_opus: 7 * 24 * 60 * 60 * 1000,
	seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
	seven_day_oauth_apps: 7 * 24 * 60 * 60 * 1000,
};

function colorForPct(pct: number): (s: string) => string {
	if (pct >= 80) return pc.red;
	if (pct >= 50) return pc.yellow;
	return pc.green;
}

function renderBar(pct: number): string {
	const filled = Math.floor((pct / 100) * BAR_WIDTH);
	const hasHalf = pct > 0 && filled < BAR_WIDTH && ((pct / 100) * BAR_WIDTH) % 1 >= 0.25;
	const color = colorForPct(pct);
	const bar = color(BLOCK_FULL.repeat(filled) + (hasHalf ? BLOCK_HALF : ""));
	const empty = " ".repeat(BAR_WIDTH - filled - (hasHalf ? 1 : 0));
	return `${bar}${empty}  ${Math.round(pct)}% used`;
}

const BUCKET_LABELS: Record<string, string> = {
	five_hour: "Current session",
	seven_day: "Current week (all models)",
	seven_day_opus: "Current week (Opus only)",
	seven_day_sonnet: "Current week (Sonnet only)",
	seven_day_oauth_apps: "Current week (OAuth apps)",
};

function bucketLabel(key: string): string {
	return BUCKET_LABELS[key] ?? key.replace(/_/g, " ");
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}

function formatResetTime(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	const now = Date.now();
	const remainingMs = d.getTime() - now;

	const timeFmt = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	});

	if (remainingMs <= 0) return `Resets ${timeFmt.format(d)}`;
	return `Resets ${timeFmt.format(d)} (${formatDuration(remainingMs)})`;
}

function calcProjection(utilization: number, resetsAt: string | null, bucketKey: string): number | null {
	if (!resetsAt || utilization <= 0) return null;
	const periodMs = BUCKET_PERIODS_MS[bucketKey];
	if (!periodMs) return null;

	const resetTime = new Date(resetsAt).getTime();
	const now = Date.now();
	const startTime = resetTime - periodMs;
	const elapsed = now - startTime;

	if (elapsed <= 0) return null;

	const projected = (utilization / elapsed) * periodMs;
	return Math.min(Math.round(projected), 100);
}

function renderProjection(projected: number): string {
	const color = colorForPct(projected);
	return color(`~${projected}% projected at end`);
}

export function renderAccountUsage(account: AccountUsage): string {
	const lines: string[] = [];
	const header = account.label
		? `${account.accountName} (${account.label})`
		: account.accountName;
	lines.push(pc.bold(`── ${header} ${"─".repeat(Math.max(0, 40 - header.length))}`));

	if (account.error) {
		lines.push(pc.red(`  Error: ${account.error}`));
		return lines.join("\n");
	}

	if (!account.usage) return lines.join("\n");

	for (const [key, bucket] of Object.entries(account.usage)) {
		if (!bucket || typeof bucket !== "object" || !("utilization" in bucket)) continue;
		lines.push(`${bucketLabel(key)}`);
		lines.push(renderBar(bucket.utilization));

		const parts: string[] = [];
		const resetStr = formatResetTime(bucket.resets_at);
		if (resetStr) parts.push(resetStr);

		const projected = calcProjection(bucket.utilization, bucket.resets_at, key);
		if (projected !== null && projected !== Math.round(bucket.utilization)) {
			parts.push(renderProjection(projected));
		}

		if (parts.length > 0) lines.push(pc.dim(parts[0]) + (parts[1] ? `  ${parts[1]}` : ""));
		lines.push("");
	}

	return lines.join("\n");
}

export function renderAllAccounts(accounts: AccountUsage[]): string {
	return accounts.map(renderAccountUsage).join("\n");
}
