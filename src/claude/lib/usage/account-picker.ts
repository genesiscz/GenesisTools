import type { ClaudeModelFamily } from "@app/claude/lib/models";
import type { AccountUsage, UsageBucket } from "./api";

/**
 * Account-picking heuristic for `tools claude start --pick/--autopick`.
 *
 * Ranking ("sustainable burn rate"):
 * 1. Session starvation gate (pro-rata): the 5h window's pace-line is
 *    100 × timeToReset / 5h — the headroom needed to burn at nominal pace
 *    until the reset. An account is starved (demoted below every ready
 *    one) when its headroom is under HALF the pace-line, i.e. the stall
 *    would eat the majority of the window's remaining capacity. A plain
 *    below-pace-line gate false-positives right after a window opens
 *    (pace-line ≈ 100%, so 8% used already trips it).
 * 2. Within a tier, rank by weekly scarcity rate =
 *    weeklyHeadroom% / hoursUntilWeeklyReset (higher = better). Capacity
 *    that refills soonest is cheapest to burn (use-it-or-lose-it).
 * 3. Tiebreak: session usable fraction = min(1, headroom / pace-line)
 *    (how much of the nominal window is actually deliverable — prefers a
 *    90%-used bucket resetting in 10 min over a 70%-used one resetting in
 *    2h), then session headroom.
 *
 * The only numbers involved are the buckets' own periods (5h, 7d) and the
 * majority-stall factor (1/2).
 */

const SESSION_PERIOD_HOURS = 5;
const WEEKLY_PERIOD_HOURS = 168;
const MS_PER_HOUR = 3_600_000;

export type AccountTier = "ready" | "session-starved" | "weekly-blocked" | "no-data";

const TIER_ORDER: Record<AccountTier, number> = {
    ready: 0,
    "session-starved": 1,
    "weekly-blocked": 2,
    "no-data": 3,
};

interface BucketView {
    /** 0–100, % of the bucket still available. */
    headroomPct: number;
    /** Hours until the bucket refills; the bucket period when no reset is scheduled. */
    hoursToReset: number;
    /** Whether a reset is actually scheduled (resets_at present and in the future). */
    hasScheduledReset: boolean;
    resetsAt: Date | null;
}

export interface ScoredAccount {
    accountName: string;
    label?: string;
    tier: AccountTier;
    /** Weekly scarcity rate in %/h of the binding weekly bucket. 0 for no-data. */
    weeklyRatePctPerHour: number;
    sessionHeadroomPct: number;
    weeklyHeadroomPct: number;
    /** min(1, sessionHeadroom / pace-line): share of the 5h window deliverable without stalling. */
    sessionUsableFraction: number;
    /** One-line human explanation for --pick hints and --autopick output. */
    why: string;
    /** Set when usage data came from a stale cache or failed entirely. */
    dataNote?: string;
}

export interface ScoreOptions {
    /** Resolved `--model` family; opus/sonnet launches bind their model-specific weekly bucket. */
    modelFamily?: ClaudeModelFamily;
    now?: Date;
}

function viewBucket(bucket: UsageBucket | null | undefined, periodHours: number, now: Date): BucketView {
    if (!bucket) {
        return { headroomPct: 100, hoursToReset: periodHours, hasScheduledReset: false, resetsAt: null };
    }

    const headroomPct = Math.min(100, Math.max(0, 100 - bucket.utilization));
    if (!bucket.resets_at) {
        return { headroomPct, hoursToReset: periodHours, hasScheduledReset: false, resetsAt: null };
    }

    const resetsAt = new Date(bucket.resets_at);
    const resetMs = resetsAt.getTime();
    if (!Number.isFinite(resetMs)) {
        // Malformed resets_at from the API — NaN <= 0 is false, so without this guard NaN
        // would flow into the ranking rates and corrupt --autopick ordering.
        return { headroomPct, hoursToReset: periodHours, hasScheduledReset: false, resetsAt: null };
    }

    const hoursToReset = (resetMs - now.getTime()) / MS_PER_HOUR;
    if (hoursToReset <= 0) {
        // Reset already passed (cache lag) — the bucket is effectively fresh.
        return { headroomPct: 100, hoursToReset: periodHours, hasScheduledReset: false, resetsAt: null };
    }

    return { headroomPct, hoursToReset, hasScheduledReset: true, resetsAt };
}

function fmtHours(hours: number): string {
    if (hours < 1) {
        return `${Math.max(1, Math.round(hours * 60))}m`;
    }

    if (hours < 48) {
        const whole = Math.floor(hours);
        const minutes = Math.round((hours - whole) * 60);
        return minutes > 0 ? `${whole}h ${minutes}m` : `${whole}h`;
    }

    return `${(hours / 24).toFixed(1)}d`;
}

function fmtRate(rate: number): string {
    return rate >= 10 ? `~${Math.round(rate)}%/h` : `~${rate.toFixed(1)}%/h`;
}

function weeklyPhrase(view: BucketView, name: string): string {
    const reset = view.hasScheduledReset ? `resets in ${fmtHours(view.hoursToReset)}` : "untouched window";
    return `${name} ${Math.round(view.headroomPct)}% left (${reset})`;
}

function sessionPhrase(view: BucketView): string {
    const reset = view.hasScheduledReset ? `resets in ${fmtHours(view.hoursToReset)}` : "no active window";
    return `5h ${Math.round(view.headroomPct)}% left (${reset})`;
}

export function scoreAccounts(accounts: AccountUsage[], opts: ScoreOptions = {}): ScoredAccount[] {
    const now = opts.now ?? new Date();

    const scored = accounts.map((account): ScoredAccount => {
        const base = { accountName: account.accountName, label: account.label };

        if (!account.usage) {
            return {
                ...base,
                tier: "no-data",
                weeklyRatePctPerHour: 0,
                sessionHeadroomPct: 0,
                weeklyHeadroomPct: 0,
                sessionUsableFraction: 0,
                why: `usage unavailable${account.error ? `: ${account.error.slice(0, 80)}` : ""}`,
                dataNote: "no data",
            };
        }

        const usage = account.usage;
        const session = viewBucket(usage.five_hour, SESSION_PERIOD_HOURS, now);
        const weekly = viewBucket(usage.seven_day, WEEKLY_PERIOD_HOURS, now);

        // The binding weekly constraint: overall bucket, plus the model-specific
        // bucket when launching that family — whichever sustains the LOWER rate.
        let binding = weekly;
        let bindingName = "wk";

        const familyBucket =
            opts.modelFamily === "opus"
                ? usage.seven_day_opus
                : opts.modelFamily === "sonnet"
                  ? usage.seven_day_sonnet
                  : undefined;

        if (familyBucket) {
            const familyView = viewBucket(familyBucket, WEEKLY_PERIOD_HOURS, now);
            if (familyView.headroomPct / familyView.hoursToReset < binding.headroomPct / binding.hoursToReset) {
                binding = familyView;
                bindingName = `${opts.modelFamily} wk`;
            }
        }

        const weeklyRate = binding.headroomPct / binding.hoursToReset;
        const staleNote = account.stale ? "stale data" : undefined;

        const paceLine = session.hasScheduledReset ? 100 * (session.hoursToReset / SESSION_PERIOD_HOURS) : 0;
        const usableFraction = paceLine > 0 ? Math.min(1, session.headroomPct / paceLine) : 1;

        if (binding.headroomPct < 1) {
            return {
                ...base,
                tier: "weekly-blocked",
                weeklyRatePctPerHour: weeklyRate,
                sessionHeadroomPct: session.headroomPct,
                weeklyHeadroomPct: binding.headroomPct,
                sessionUsableFraction: usableFraction,
                why: `${bindingName} exhausted — refills in ${fmtHours(binding.hoursToReset)}`,
                dataNote: staleNote,
            };
        }

        if (paceLine > 0 && session.headroomPct < paceLine / 2) {
            return {
                ...base,
                tier: "session-starved",
                weeklyRatePctPerHour: weeklyRate,
                sessionHeadroomPct: session.headroomPct,
                weeklyHeadroomPct: binding.headroomPct,
                sessionUsableFraction: usableFraction,
                why: `would stall — ${sessionPhrase(session)}, needs ${Math.round(paceLine)}% to keep pace · ${weeklyPhrase(binding, bindingName)}`,
                dataNote: staleNote,
            };
        }

        const usableNote = usableFraction < 0.99 ? `, ~${Math.round(usableFraction * 100)}% usable` : "";
        return {
            ...base,
            tier: "ready",
            weeklyRatePctPerHour: weeklyRate,
            sessionHeadroomPct: session.headroomPct,
            weeklyHeadroomPct: binding.headroomPct,
            sessionUsableFraction: usableFraction,
            why: `${fmtRate(weeklyRate)} sustainable — ${weeklyPhrase(binding, bindingName)} · ${sessionPhrase(session)}${usableNote}`,
            dataNote: staleNote,
        };
    });

    return scored.sort((a, b) => {
        if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) {
            return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
        }

        if (b.weeklyRatePctPerHour !== a.weeklyRatePctPerHour) {
            return b.weeklyRatePctPerHour - a.weeklyRatePctPerHour;
        }

        if (b.sessionUsableFraction !== a.sessionUsableFraction) {
            return b.sessionUsableFraction - a.sessionUsableFraction;
        }

        return b.sessionHeadroomPct - a.sessionHeadroomPct;
    });
}
