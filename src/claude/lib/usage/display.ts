import pc from "picocolors";
import type { AccountUsage } from "./api";

const BAR_WIDTH = 40;
const BLOCK_FULL = "\u2588"; // █
const BLOCK_HALF = "\u258C"; // ▌

// --- Color logic ---

function colorForPct(pct: number): (s: string) => string {
	if (pct >= 80) return pc.red;
	if (pct >= 50) return pc.yellow;
	return pc.green;
}

// --- Progress bar ---

function renderBar(pct: number): string {
	const filled = Math.floor((pct / 100) * BAR_WIDTH);
	const hasHalf = pct > 0 && filled < BAR_WIDTH && ((pct / 100) * BAR_WIDTH) % 1 >= 0.25;
	const color = colorForPct(pct);
	const bar = color(BLOCK_FULL.repeat(filled) + (hasHalf ? BLOCK_HALF : ""));
	const empty = " ".repeat(BAR_WIDTH - filled - (hasHalf ? 1 : 0));
	return `${bar}${empty}  ${Math.round(pct)}% used`;
}

// --- Bucket labels ---

const BUCKET_LABELS: Record<string, string> = {
	five_hour: "Current session",
	seven_day: "Current week (all models)",
	seven_day_opus: "Current week (Opus only)",
	seven_day_oauth_apps: "Current week (OAuth apps)",
};

function bucketLabel(key: string): string {
	return BUCKET_LABELS[key] ?? key.replace(/_/g, " ");
}

// --- Reset time formatting ---

function formatResetTime(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	const timeFmt = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		timeZoneName: "short",
	});
	return `Resets ${timeFmt.format(d)}`;
}

// --- Render account usage ---

export function renderAccountUsage(account: AccountUsage): string {
	const lines: string[] = [];
	const header = account.email
		? `${account.accountName} (${account.email})`
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
		const resetStr = formatResetTime(bucket.resets_at);
		if (resetStr) lines.push(pc.dim(resetStr));
		lines.push("");
	}

	return lines.join("\n");
}

export function renderAllAccounts(accounts: AccountUsage[]): string {
	return accounts.map(renderAccountUsage).join("\n");
}
