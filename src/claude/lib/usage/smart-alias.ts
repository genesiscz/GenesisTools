import { FABLE_EXHAUSTED_PCT, fmtHours, type ScoredAccount } from "./account-picker";
import { type CompactLimit, effectiveLeftPct } from "./compact-limits";

/**
 * Smart aliases — `cc opus` / `cc fable` pick the account instead of the TUI.
 * Two different jobs, so two different rules:
 *
 *   opus  — spend the leftovers. Prefer an account whose Fable bucket is
 *           already gone (its weekly is only good for Opus/Sonnet anyway, so
 *           Fable-capable accounts stay reserved for Fable work), require a
 *           floor of headroom so the session doesn't die on turn three, and
 *           among what clears the floor take the EMPTIEST — drain the
 *           nearly-spent account before opening a fresh one.
 *
 *   fable — the opposite: Fable means a long run, so take the account with the
 *           most room. Anything within a band of the best counts as "enough
 *           room", and inside that band the one that RESETS SOONEST wins —
 *           capacity that would evaporate anyway gets spent first.
 *
 * Neither ever blocks a launch: when nothing qualifies the caller falls back
 * to the normal picker, and an opus pick below the floor launches with a
 * warning rather than refusing.
 */

export type SmartAlias = "opus" | "fable";

const SMART_ALIASES: SmartAlias[] = ["opus", "fable"];

/** `cc opus` wants at least this much weekly headroom before auto-picking. */
export const OPUS_WEEKLY_FLOOR_PCT = 10;

/** Fable candidates within this many points of the best count as "enough room". */
export const FABLE_BAND_PCT = 10;

const MS_PER_HOUR = 3_600_000;

export interface SmartPick {
    accountName: string;
    /** One-line headroom readout printed before the launch. */
    line: string;
    /** Set when the pick had to bend a rule (nothing cleared the floor). */
    warning?: string;
}

interface Candidate {
    scored: ScoredAccount;
    weekly?: CompactLimit;
    fable?: CompactLimit;
    weeklyLeft: number;
    fableLeft: number;
    sessionLeft: number;
    /** Epoch ms of the Fable reset; Infinity when none is scheduled. */
    fableResetMs: number;
}

/** Epoch ms of a scheduled reset — Infinity when absent or already passed. */
function resetMs(limit: CompactLimit | undefined, now: Date): number {
    if (!limit?.resetsAt) {
        return Number.POSITIVE_INFINITY;
    }

    const ms = new Date(limit.resetsAt).getTime();
    return Number.isFinite(ms) && ms > now.getTime() ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Accounts an auto-pick may launch: usage actually read (no `no-data` rows),
 * subscription alive, weekly bucket not exhausted.
 */
function candidatesOf(scored: ScoredAccount[], now: Date): Candidate[] {
    return scored
        .filter((s) => s.limits && !s.subscriptionExpired && s.group !== "dead" && s.group !== "expired")
        .map((s) => ({
            scored: s,
            weekly: s.limits?.weekly,
            fable: s.limits?.fable,
            weeklyLeft: effectiveLeftPct(s.limits?.weekly, now),
            fableLeft: effectiveLeftPct(s.limits?.fable, now),
            sessionLeft: effectiveLeftPct(s.limits?.session, now),
            fableResetMs: resetMs(s.limits?.fable, now),
        }));
}

function pct(value: number): string {
    return `${Math.round(value)}%`;
}

function resetPhrase(limit: CompactLimit | undefined, now: Date): string {
    const ms = resetMs(limit, now);

    if (!Number.isFinite(ms)) {
        return "untouched window";
    }

    return `resets in ${fmtHours((ms - now.getTime()) / MS_PER_HOUR)}`;
}

function opusLine(candidate: Candidate, now: Date): string {
    return (
        `${candidate.scored.accountName} · wk ${pct(candidate.weeklyLeft)} left ` +
        `(${resetPhrase(candidate.weekly, now)}) · 5h ${pct(candidate.sessionLeft)} left`
    );
}

function fableLine(candidate: Candidate, now: Date): string {
    return (
        `${candidate.scored.accountName} · fable ${pct(candidate.fableLeft)} left ` +
        `(${resetPhrase(candidate.fable, now)}) · wk ${pct(candidate.weeklyLeft)} left`
    );
}

/** Fable burns BOTH weekly buckets — the room you really have is the smaller. */
function fableRoom(candidate: Candidate): number {
    return Math.min(candidate.fableLeft, candidate.weeklyLeft);
}

export function pickOpus(scored: ScoredAccount[], now: Date = new Date()): SmartPick | null {
    const pool = candidatesOf(scored, now);

    if (pool.length === 0) {
        return null;
    }

    const eligible = pool.filter((c) => c.weeklyLeft >= OPUS_WEEKLY_FLOOR_PCT);

    if (eligible.length === 0) {
        const fullest = [...pool].sort((a, b) => b.weeklyLeft - a.weeklyLeft)[0];

        return {
            accountName: fullest.scored.accountName,
            line: opusLine(fullest, now),
            warning: `No account has ≥${OPUS_WEEKLY_FLOOR_PCT}% weekly left — using the fullest one.`,
        };
    }

    const ranked = [...eligible].sort(
        (a, b) =>
            // A spent 5h window cannot start anything right now.
            Number(a.scored.cooling) - Number(b.scored.cooling) ||
            // Fable-capable accounts are saved for Fable work.
            Number(a.scored.group === "fable") - Number(b.scored.group === "fable") ||
            // Emptiest first: finish a partly-spent week before opening a fresh one.
            a.weeklyLeft - b.weeklyLeft ||
            a.scored.accountName.localeCompare(b.scored.accountName)
    );

    return { accountName: ranked[0].scored.accountName, line: opusLine(ranked[0], now) };
}

export function pickFable(scored: ScoredAccount[], now: Date = new Date()): SmartPick | null {
    const pool = candidatesOf(scored, now).filter(
        (c) => c.scored.group === "fable" && c.fableLeft > FABLE_EXHAUSTED_PCT
    );

    if (pool.length === 0) {
        return null;
    }

    const best = Math.max(...pool.map(fableRoom));
    const band = pool.filter((c) => fableRoom(c) >= best - FABLE_BAND_PCT);

    const ranked = [...band].sort(
        (a, b) =>
            // Enough room is settled by the band — inside it, spend what expires first.
            a.fableResetMs - b.fableResetMs ||
            fableRoom(b) - fableRoom(a) ||
            a.scored.accountName.localeCompare(b.scored.accountName)
    );

    return { accountName: ranked[0].scored.accountName, line: fableLine(ranked[0], now) };
}

export function pickSmart(alias: SmartAlias, scored: ScoredAccount[], now: Date = new Date()): SmartPick | null {
    return alias === "opus" ? pickOpus(scored, now) : pickFable(scored, now);
}

/**
 * Read `cc <word>` as an alias — unless a real account owns that name, in
 * which case an explicit pick must never be hijacked.
 */
export function smartAliasOf(nameArg: string | undefined, accountNames: string[]): SmartAlias | null {
    if (!nameArg) {
        return null;
    }

    const lower = nameArg.toLowerCase();
    const alias = SMART_ALIASES.find((a) => a === lower);

    if (!alias || accountNames.some((name) => name.toLowerCase() === lower)) {
        return null;
    }

    return alias;
}
