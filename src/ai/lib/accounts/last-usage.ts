import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
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
    const rows = cache?.providers[account.provider]?.accounts;

    if (!rows || rows.length === 0) {
        return undefined;
    }

    // By id first: a rename keeps the id, so a snapshot recorded under the old name
    // still belongs to this account. The name is the fallback for a row written
    // before the writers carried an id.
    return (
        rows.find((row) => row.accountId !== "" && row.accountId === account.id) ??
        rows.find((row) => row.accountName === account.name)
    );
}

/**
 * A window as one line: `5h   42.0%`, with the money pair appended for a credit
 * window and the reset time when the provider gave one.
 *
 * The money rule (divide by the currency's OWN exponent, never a fixed 2, so KWD
 * and BHD keep their third digit) is the same one `formatMoney` applies in
 * `src/utils/ink/usage-dashboard/views/account-section.tsx:18`. It is repeated here
 * rather than imported because that module pulls in Ink and React, and this file is
 * loaded on every `tools ai` invocation.
 */
export function formatLimitLine(window: LimitWindow, now: number = Date.now()): string {
    const parts = [`${window.percentUsed.toFixed(1)}%`];

    if (window.money) {
        const { usedMinor, limitMinor, currency, exponent } = window.money;
        const divisor = 10 ** exponent;
        const used = (usedMinor / divisor).toFixed(exponent);
        parts.push(
            limitMinor === undefined
                ? `${used} ${currency}`
                : `${used} / ${(limitMinor / divisor).toFixed(exponent)} ${currency}`
        );
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
