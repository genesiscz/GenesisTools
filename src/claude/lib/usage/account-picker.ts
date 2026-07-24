import type { ClaudeModelFamily } from "@app/claude/lib/models";
import type { AccountUsage, UsageBucket } from "./api";
import { type CompactLimits, effectiveLeftPct, extractCompactLimits } from "./compact-limits";

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
 *
 * GROUPED URGENCY (the `group`/`score`/`cooling` fields) is the alternative
 * ordering: accounts partition into fable / opus / dead / expired, and inside a
 * group rank by capacity that evaporates soonest. `sortGrouped` applies it;
 * `scoreAccounts` still returns tier order so existing callers are unchanged.
 */

const SESSION_PERIOD_HOURS = 5;
const WEEKLY_PERIOD_HOURS = 168;
const MS_PER_HOUR = 3_600_000;
/** weekly_all at/below this headroom ⇒ the account can't serve any model. */
const DEAD_HEADROOM_PCT = 2;
/** 5h window at/below this ⇒ "cooling": sinks to its group's bottom until the reset. */
const COOLING_HEADROOM_PCT = 2;
/** Fable weekly at/below this ⇒ effectively exhausted, the account is Opus-only. */
export const FABLE_EXHAUSTED_PCT = 1;
/** Fable weekly at/below this ⇒ low enough that a launcher should confirm first. */
export const FABLE_LOW_PCT = 3;

/** A dead LOGIN, not a spent bucket — no refresh will fix it. */
const EXPIRED_ERROR_RE = /invalid_grant|Usage API 401/i;

export type AccountTier = "ready" | "session-starved" | "weekly-blocked" | "no-data";
export type AccountGroup = "fable" | "opus" | "dead" | "expired";

const TIER_ORDER: Record<AccountTier, number> = {
    ready: 0,
    "session-starved": 1,
    "weekly-blocked": 2,
    "no-data": 3,
};

const GROUP_ORDER: Record<AccountGroup, number> = {
    fable: 0,
    opus: 1,
    dead: 2,
    expired: 3,
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
    /** Grouped-urgency partition: fable → opus → dead → expired. */
    group: AccountGroup;
    /** Grouped-urgency rank inside the group (bindingRate × usable5h), higher first. */
    score: number;
    /** 5h window nearly spent — sinks to the group bottom until its reset passes. */
    cooling: boolean;
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
    /** Compact 5h / weekly / Fable readout for the table-picker columns. */
    limits?: CompactLimits;
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

/** Hours until a compact limit's reset; the bucket period when none is scheduled or it already passed. */
function hoursToReset(resetsAt: string | null | undefined, periodHours: number, now: Date): number {
    if (!resetsAt) {
        return periodHours;
    }

    const hours = (new Date(resetsAt).getTime() - now.getTime()) / MS_PER_HOUR;

    return Number.isFinite(hours) && hours > 0 ? hours : periodHours;
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
            const expired = account.error !== undefined && EXPIRED_ERROR_RE.test(account.error);

            return {
                ...base,
                tier: "no-data",
                // Unknown is NOT Opus-only: an un-pollable account keeps its place
                // in the fable group's tail (score 0) instead of being demoted.
                group: expired ? "expired" : "fable",
                score: 0,
                cooling: false,
                weeklyRatePctPerHour: 0,
                sessionHeadroomPct: 0,
                weeklyHeadroomPct: 0,
                sessionUsableFraction: 0,
                why: expired
                    ? `login dead — run tools claude login ${account.accountName}`
                    : `usage unavailable${account.error ? `: ${account.error.slice(0, 80)}` : ""}`,
                dataNote: expired ? "expired" : "no data",
            };
        }

        const usage = account.usage;
        const session = viewBucket(usage.five_hour, SESSION_PERIOD_HOURS, now);
        const weekly = viewBucket(usage.seven_day, WEEKLY_PERIOD_HOURS, now);
        const limits = extractCompactLimits(usage);

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

        // Grouped urgency. Fable burns BOTH its own weekly bucket and weekly_all,
        // so the fable group is ruled by whichever sustains the LOWER rate; the
        // opus group runs on the binding weekly bucket alone.
        const fableLeft = effectiveLeftPct(limits.fable, now);
        const fableAvailable = !limits.fable || fableLeft > FABLE_EXHAUSTED_PCT;
        const fableRate = limits.fable
            ? fableLeft / hoursToReset(limits.fable.resetsAt, WEEKLY_PERIOD_HOURS, now)
            : Number.POSITIVE_INFINITY;

        const dead = binding.headroomPct <= DEAD_HEADROOM_PCT;
        const cooling = !dead && session.headroomPct <= COOLING_HEADROOM_PCT;
        const group: AccountGroup = dead ? "dead" : fableAvailable ? "fable" : "opus";
        const bindingRate = group === "fable" ? Math.min(fableRate, weeklyRate) : weeklyRate;
        const score = bindingRate * usableFraction;
        const grouped = { group, score, cooling };

        if (binding.headroomPct < 1) {
            return {
                ...base,
                ...grouped,
                cooling: false,
                tier: "weekly-blocked",
                weeklyRatePctPerHour: weeklyRate,
                sessionHeadroomPct: session.headroomPct,
                weeklyHeadroomPct: binding.headroomPct,
                sessionUsableFraction: usableFraction,
                why: `${bindingName} exhausted — refills in ${fmtHours(binding.hoursToReset)}`,
                dataNote: staleNote,
                limits,
            };
        }

        if (paceLine > 0 && session.headroomPct < paceLine / 2) {
            return {
                ...base,
                ...grouped,
                tier: "session-starved",
                weeklyRatePctPerHour: weeklyRate,
                sessionHeadroomPct: session.headroomPct,
                weeklyHeadroomPct: binding.headroomPct,
                sessionUsableFraction: usableFraction,
                why: `would stall — ${sessionPhrase(session)}, needs ${Math.round(paceLine)}% to keep pace · ${weeklyPhrase(binding, bindingName)}`,
                dataNote: staleNote,
                limits,
            };
        }

        const usableNote = usableFraction < 0.99 ? `, ~${Math.round(usableFraction * 100)}% usable` : "";
        return {
            ...base,
            ...grouped,
            tier: "ready",
            weeklyRatePctPerHour: weeklyRate,
            sessionHeadroomPct: session.headroomPct,
            weeklyHeadroomPct: binding.headroomPct,
            sessionUsableFraction: usableFraction,
            why: `${fmtRate(weeklyRate)} sustainable — ${weeklyPhrase(binding, bindingName)} · ${sessionPhrase(session)}${usableNote}`,
            dataNote: staleNote,
            limits,
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

/**
 * Grouped-urgency ordering: fable → opus → dead → expired, cooling accounts at
 * each group's bottom, then highest urgency score first. Stable, so ties keep
 * the order they came in with (config order, since `scoreAccounts` preserves it
 * for equal keys). Sorts a COPY — callers may keep the tier-ordered array.
 */
export function sortGrouped(scored: ScoredAccount[]): ScoredAccount[] {
    return [...scored].sort(
        (a, b) =>
            GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || Number(a.cooling) - Number(b.cooling) || b.score - a.score
    );
}
