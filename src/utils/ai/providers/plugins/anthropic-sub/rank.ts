import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import type { AccountRanker, RankedAccount, RankTier } from "@genesiscz/utils/ai/providers/usage-rank";
import type { AccountUsage, ApiLimit, UsageBucket, UsageResponse } from "./api";
import { type AccountTier, type ScoredAccount, scoreAccounts, sortGrouped } from "./scorer";
import { previousUsageOf, snapshotToAccountUsage } from "./snapshot-usage";

/** The scorer's tiers are the shared tiers; the table makes the compiler say so when one side gains a tier. */
const TIERS: Record<AccountTier, RankTier> = {
    ready: "ready",
    "session-starved": "session-starved",
    "weekly-blocked": "weekly-blocked",
    "no-data": "no-data",
};

/**
 * The scorer's `dead` and `expired` groups are gates of their own, apart from its tier: a week at 99% is `dead`
 * (headroom at most 2%) while its tier stays `ready` (`weekly-blocked` needs under 1%), and a stale payload under a
 * dead login is `expired` with any tier. The Claude launchers skip both groups; the shared row says so in its tier,
 * which no pick accepts.
 */
function tierOf(row: ScoredAccount): RankTier {
    if (row.group === "expired" || row.subscriptionExpired) {
        return "no-data";
    }

    if (row.group === "dead") {
        return "weekly-blocked";
    }

    return TIERS[row.tier];
}

function toRanked(row: ScoredAccount, snapshot: AccountUsageSnapshot, sessions: number): RankedAccount {
    return {
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        accountName: row.accountName,
        tier: tierOf(row),
        longHeadroomPct: row.weeklyHeadroomPct,
        sessionHeadroomPct: row.sessionHeadroomPct,
        // The scorer already prefers capacity that refills soonest (its weekly scarcity rate); no separate bonus.
        resetBonus: 0,
        sessions,
        score: row.score,
        why: row.why,
    };
}

const API_KINDS: Partial<Record<LimitWindow["kind"], string>> = {
    session: "session",
    weekly: "weekly_all",
    scoped: "weekly_scoped",
};

function bucketOf(window: LimitWindow): UsageBucket {
    return { utilization: window.percentUsed, resets_at: window.resetsAt ?? null };
}

/**
 * A `UsageResponse` rebuilt from the provider-neutral windows, for a snapshot that crossed a file or a wire and
 * lost its `native` payload (`snapshots.json` never stores it). The windows came from `toLimitWindows`, so each key
 * is the bucket it was read from; a scoped window's model goes back into `limits[]`, where the scorer finds Fable.
 * Undefined without a weekly window: the scorer needs one, and a guess would invent headroom.
 */
export function usageFromWindows(snapshot: AccountUsageSnapshot): UsageResponse | undefined {
    // By key: `seven_day_oauth_apps` is an unscoped weekly window too, and the file keeps no order between them.
    const weekly = snapshot.limits.find((window) => window.key === "seven_day" && !window.scopeModel);

    if (!weekly) {
        return undefined;
    }

    const session = snapshot.limits.find((window) => window.key === "five_hour");

    if (!session && !snapshot.absentLimits?.some((window) => window.key === "five_hour")) {
        return undefined;
    }
    const usage: UsageResponse = { five_hour: session ? bucketOf(session) : null, seven_day: bucketOf(weekly) };
    const limits: ApiLimit[] = [];

    for (const window of snapshot.limits) {
        const kind = API_KINDS[window.kind];

        if (!kind) {
            continue;
        }

        if (window.kind === "scoped") {
            usage[window.key] = bucketOf(window);
        }

        limits.push({
            kind,
            percent: window.percentUsed,
            severity: window.severity ?? "ok",
            resets_at: window.resetsAt ?? null,
            scope: window.scopeModel
                ? { model: { id: window.scopeModel, display_name: window.scopeModel }, surface: null }
                : null,
            is_active: window.isActive ?? true,
        });
    }

    return { ...usage, limits };
}

/** The scorer's row: the untouched payload when the snapshot carries one, else the windows rebuilt. */
function accountUsageOf(snapshot: AccountUsageSnapshot): AccountUsage {
    const row = snapshotToAccountUsage(snapshot);

    if (previousUsageOf(snapshot)) {
        return row;
    }

    const rebuilt = usageFromWindows(snapshot);
    return rebuilt ? { ...row, usage: rebuilt } : row;
}

/**
 * Claude's ranker: `scoreAccounts` in the grouped order (`sortGrouped`), the order `tools claude usage --json
 * --scored` prints, so every door ranks a Claude account the same way. It reads the untouched `UsageResponse` a
 * live snapshot carries in `native`, or the windows rebuilt into one (`usageFromWindows`) for a cached snapshot.
 */
export const anthropicRanker: AccountRanker = {
    rank(snapshots, options) {
        const byName = new Map(snapshots.map((snapshot) => [snapshot.accountName, snapshot]));
        const scored = sortGrouped(
            scoreAccounts(snapshots.map(accountUsageOf), options.now ? { now: options.now } : {})
        );

        return scored.flatMap((row) => {
            const snapshot = byName.get(row.accountName);
            return snapshot ? [toRanked(row, snapshot, options.sessions?.[row.accountName] ?? 0)] : [];
        });
    },
};
