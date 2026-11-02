import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import {
    type AccountUsageSnapshot,
    absentLimitKindLabel,
    absentLimitText,
    type LimitWindow,
    snapshotOfAccount,
} from "@genesiscz/utils/ai/providers/account-features";
import { formatMoney, percentOf } from "@genesiscz/utils/ai/usage-poll/format-money";
import type { SnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";

/**
 * The last recorded usage snapshot for one account, read out of the all-provider
 * cache (`~/.genesis-tools/ai-usage/cache/snapshots.json`, spec 6.4).
 *
 * That file, NOT `UsageLimitsDb`: constructing the limits DB runs `CREATE TABLE`,
 * `ALTER TABLE` and `runMigrations` on the way in (`usage-poll/limits-db.ts:165-223`),
 * and `tools ai accounts show` is a diagnostic, which may not write (repo CLAUDE.md,
 * "A diagnostic must never mutate"). The cache also already holds the whole
 * `AccountUsageSnapshot`, which is exactly the unit spec 5.1 asks `show` to print,
 * while the DB holds a per-bucket time series.
 */
export function lastSnapshotFor(cache: SnapshotsCache | null, account: AccountEntry): AccountUsageSnapshot | undefined {
    return snapshotOfAccount(cache?.providers[account.provider]?.accounts, account);
}

/** One labelled row under "Last usage" in `tools ai accounts show`. */
export interface UsageRow {
    label: string;
    value: string;
}

/**
 * The rows `show` prints for a snapshot: every recorded window, then every window the provider
 * confirmed absent. Empty only when the snapshot holds neither, which `show` reports as "No windows
 * recorded"; a reading that names only an absent window still prints its "no 5h limit" row.
 */
export function usageRows(
    snapshot: Pick<AccountUsageSnapshot, "limits" | "absentLimits">,
    now: number = Date.now()
): UsageRow[] {
    return [
        ...snapshot.limits.map((window) => ({ label: window.label, value: formatLimitLine(window, now) })),
        ...(snapshot.absentLimits ?? []).map((limit) => ({
            label: absentLimitKindLabel(limit),
            value: `— ${absentLimitText(limit)} on this account`,
        })),
    ];
}

/**
 * A window as one line: `5h   42.0%`, with the money pair appended for a credit
 * window and the reset time when the provider gave one.
 */
export function formatLimitLine(window: LimitWindow, now: number = Date.now()): string {
    const parts = [`${percentOf(window).toFixed(1)}%`];

    const money = formatMoney(window);

    if (money) {
        parts.push(money);
    }

    if (window.resetsAt) {
        const resetsMs = new Date(window.resetsAt).getTime();

        if (!Number.isNaN(resetsMs)) {
            parts.push(resetsMs > now ? `resets in ${formatGap(resetsMs - now)}` : "reset due");
        }
    }

    return parts.join("  ·  ");
}

/** `2h 15m`, `45m`, `30s`. Short enough to sit at the end of a one-line window row. */
function formatGap(ms: number): string {
    const minutes = Math.floor(ms / 60_000);

    if (minutes < 1) {
        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    }

    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
