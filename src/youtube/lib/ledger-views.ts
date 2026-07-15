import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { LedgerPage, LedgerRowData, UsageByReason, UsageSummary } from "@app/youtube/lib/ledger-views.types";
import { ledgerReasonGroup } from "@app/youtube/lib/ledger-views.types";

export { ledgerReasonGroup } from "@app/youtube/lib/ledger-views.types";

interface LedgerAggregateRow {
    day: string;
    delta: number;
    reason: string;
}

export function getUsageSummary(db: YoutubeDatabase, userId: number): UsageSummary {
    const rows = db
        .getDb()
        .query<LedgerAggregateRow, [number]>(
            "SELECT substr(created_at, 1, 10) AS day, delta, reason FROM credit_ledger WHERE user_id = ?"
        )
        .all(userId);

    const dayBuckets = last30DaysUtc();
    const dayIndex = new Map(dayBuckets.map((date, index) => [date, index]));
    const spentByDay = new Array<number>(dayBuckets.length).fill(0);
    const earnedByDay = new Array<number>(dayBuckets.length).fill(0);
    const byReason = new Map<string, UsageByReason>();
    const currentMonthPrefix = dayBuckets[dayBuckets.length - 1].slice(0, 7);
    let monthSpent = 0;
    let monthEarned = 0;

    for (const row of rows) {
        const group = ledgerReasonGroup(row.reason);
        const bucket = byReason.get(group) ?? { reason: group, spent: 0, count: 0 };
        bucket.count += 1;

        if (row.delta < 0) {
            bucket.spent += -row.delta;
        }

        byReason.set(group, bucket);

        const dayPos = dayIndex.get(row.day);

        if (dayPos !== undefined) {
            if (row.delta < 0) {
                spentByDay[dayPos] += -row.delta;
            } else {
                earnedByDay[dayPos] += row.delta;
            }
        }

        if (row.day.startsWith(currentMonthPrefix)) {
            if (row.delta < 0) {
                monthSpent += -row.delta;
            } else {
                monthEarned += row.delta;
            }
        }
    }

    const days = dayBuckets.map((date, index) => ({
        date,
        spent: spentByDay[index],
        earned: earnedByDay[index],
    }));

    return {
        days,
        byReason: [...byReason.values()],
        month: { spent: monthSpent, earned: monthEarned },
    };
}

/** Last 30 calendar dates (UTC, `YYYY-MM-DD`), oldest first, ending today. */
function last30DaysUtc(): string[] {
    const now = new Date();
    const dates: string[] = [];

    for (let offset = 29; offset >= 0; offset--) {
        const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
        dates.push(day.toISOString().slice(0, 10));
    }

    return dates;
}

interface LedgerDbRow {
    id: number;
    delta: number;
    reason: string;
    balance_after: number;
    created_at: string;
}

/** Newest-first keyset pagination over `credit_ledger` (`WHERE id < before`). */
export function getLedgerPage(
    db: YoutubeDatabase,
    userId: number,
    opts: { limit?: number; before?: number } = {}
): LedgerPage {
    const limit = opts.limit ?? 50;
    const rawRows =
        opts.before !== undefined
            ? db
                  .getDb()
                  .query<LedgerDbRow, [number, number, number]>(
                      `SELECT id, delta, reason, balance_after, created_at FROM credit_ledger
                       WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
                  )
                  .all(userId, opts.before, limit)
            : db
                  .getDb()
                  .query<LedgerDbRow, [number, number]>(
                      `SELECT id, delta, reason, balance_after, created_at FROM credit_ledger
                       WHERE user_id = ? ORDER BY id DESC LIMIT ?`
                  )
                  .all(userId, limit);

    const rows: LedgerRowData[] = rawRows.map((row) => ({
        id: row.id,
        delta: row.delta,
        reason: row.reason,
        balanceAfter: row.balance_after,
        createdAt: row.created_at,
        // `credit_ledger` has no video/question reference of its own — only
        // "ask" spends can be joined back to a question via qa_history's
        // nearest-timestamp match. Everything else (grants, summary spends,
        // stripe events) has no reliable source to resolve a context string
        // from, so it stays null (best-effort, per the plan's own wording).
        context: row.reason === "ask" ? (db.findQaForLedgerRow(userId, row.created_at)?.question ?? null) : null,
    }));

    const nextBefore = rows.length === limit ? rows[rows.length - 1].id : null;

    return { rows, nextBefore };
}
