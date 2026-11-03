import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import type { AccountRanker, RankedAccount, RankTier } from "@genesiscz/utils/ai/usage/account-rank";
import { type AccountTier, type ScoredAccount, scoreAccounts, sortGrouped } from "./scorer";
import { snapshotToAccountUsage } from "./usage";

/** The scorer's tiers are the shared tiers; the table makes the compiler say so when one side gains a tier. */
const TIERS: Record<AccountTier, RankTier> = {
    ready: "ready",
    "session-starved": "session-starved",
    "weekly-blocked": "weekly-blocked",
    "no-data": "no-data",
};

function toRanked(row: ScoredAccount, snapshot: AccountUsageSnapshot, sessions: number): RankedAccount {
    return {
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        accountName: row.accountName,
        tier: TIERS[row.tier],
        longHeadroomPct: row.weeklyHeadroomPct,
        sessionHeadroomPct: row.sessionHeadroomPct,
        // The scorer already prefers capacity that refills soonest (its weekly scarcity rate); no separate bonus.
        resetBonus: 0,
        sessions,
        score: row.score,
        why: row.why,
    };
}

/**
 * Claude's ranker: `scoreAccounts` in the grouped order (`sortGrouped`), the order `tools claude usage --json
 * --scored` prints, so every door ranks a Claude account the same way. It reads the untouched `UsageResponse` each
 * snapshot carries in `native`, because the per-model weekly windows and the Fable rules live there.
 */
export const anthropicRanker: AccountRanker = {
    rank(snapshots, options) {
        const byName = new Map(snapshots.map((snapshot) => [snapshot.accountName, snapshot]));
        const scored = sortGrouped(
            scoreAccounts(snapshots.map(snapshotToAccountUsage), options.now ? { now: options.now } : {})
        );

        return scored.flatMap((row) => {
            const snapshot = byName.get(row.accountName);
            return snapshot ? [toRanked(row, snapshot, options.sessions?.[row.accountName] ?? 0)] : [];
        });
    },
};
