import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";

/**
 * The shared `auto` account pick (P7) for Codex and Grok, over the provider-neutral usage snapshot. Claude keeps its
 * own scorer (`scoreAccounts`), which knows the per-model weekly windows.
 *
 * Tiers first: `ready`, then `session-starved` (the short window is spent, the long one is not). A `weekly-blocked`
 * or `no-data` account is never picked: guessing onto a dead account is the failure `auto` exists to prevent. Inside
 * a tier the best share wins: the long window's headroom, plus the part of it that resets unused within a day,
 * divided by 1 + the sessions already on the account, so parallel sessions spread (the idea of switcheroo's
 * `pickCodexRow`).
 */
export type RankTier = "ready" | "session-starved" | "weekly-blocked" | "no-data";

export interface RankedAccount {
    accountName: string;
    tier: RankTier;
    /** 100 minus the long window's percent (weekly; monthly for Grok). */
    longHeadroomPct: number;
    sessionHeadroomPct: number;
    /** Long-window headroom that resets within a day, weighted by how soon. */
    resetBonus: number;
    sessions: number;
    score: number;
    why: string;
}

const TIER_ORDER: readonly RankTier[] = ["ready", "session-starved", "weekly-blocked", "no-data"];
const RESET_SOON_MS = 24 * 3_600_000;
const LONG_KINDS: ReadonlySet<LimitWindow["kind"]> = new Set(["weekly", "monthly"]);

function mostUsed(windows: LimitWindow[]): LimitWindow | undefined {
    return windows.reduce<LimitWindow | undefined>(
        (top, window) => (!top || window.percentUsed > top.percentUsed ? window : top),
        undefined
    );
}

function headroom(window: LimitWindow | undefined): number {
    return window ? Math.max(0, 100 - window.percentUsed) : 100;
}

function resetBonusOf(window: LimitWindow | undefined, now: number): number {
    const resetsAt = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;

    if (!window || !Number.isFinite(resetsAt) || resetsAt <= now || resetsAt - now >= RESET_SOON_MS) {
        return 0;
    }

    return headroom(window) * (1 - (resetsAt - now) / RESET_SOON_MS);
}

function rankOne(snapshot: AccountUsageSnapshot, sessions: number, now: number): RankedAccount {
    const base = { accountName: snapshot.accountName, sessions, resetBonus: 0, score: 0 };
    const long = mostUsed(snapshot.limits.filter((window) => LONG_KINDS.has(window.kind) && !window.scopeModel));
    const short = mostUsed(snapshot.limits.filter((window) => window.kind === "session"));

    if (snapshot.error || snapshot.needsLogin || (!long && !short)) {
        return {
            ...base,
            tier: "no-data",
            longHeadroomPct: 0,
            sessionHeadroomPct: 0,
            why: snapshot.needsLogin
                ? `needs a login: ${snapshot.needsLogin.remedy}`
                : (snapshot.error ?? "no usage data"),
        };
    }

    const longHeadroomPct = headroom(long);
    const sessionHeadroomPct = headroom(short);
    const resetBonus = resetBonusOf(long, now);
    const tier: RankTier =
        longHeadroomPct <= 0 ? "weekly-blocked" : sessionHeadroomPct <= 0 ? "session-starved" : "ready";
    const score = (longHeadroomPct + resetBonus) / (1 + sessions);
    const parts = [
        `${long?.label ?? "long"} ${Math.round(longHeadroomPct)}% left`,
        `${short?.label ?? "short"} ${Math.round(sessionHeadroomPct)}% left`,
        ...(resetBonus > 0 ? [`resets within a day (+${Math.round(resetBonus)})`] : []),
        ...(sessions > 0 ? [`${sessions} session${sessions === 1 ? "" : "s"} on it`] : []),
    ];

    return { ...base, tier, longHeadroomPct, sessionHeadroomPct, resetBonus, score, why: parts.join(", ") };
}

/** Every account ranked: tier, then share, then short-window headroom, then name (a stable order). */
export function rankAccounts(
    snapshots: AccountUsageSnapshot[],
    options: { sessions?: Record<string, number>; now?: Date } = {}
): RankedAccount[] {
    const now = (options.now ?? new Date()).getTime();

    return snapshots
        .map((snapshot) => rankOne(snapshot, options.sessions?.[snapshot.accountName] ?? 0, now))
        .sort(
            (a, b) =>
                TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
                b.score - a.score ||
                b.sessionHeadroomPct - a.sessionHeadroomPct ||
                a.accountName.localeCompare(b.accountName)
        );
}

/** The pick and the runner-up among the accounts `auto` may use; undefined when none may be used. */
export function pickRanked(ranked: RankedAccount[]): { pick: RankedAccount; runnerUp?: RankedAccount } | undefined {
    const usable = ranked.filter((account) => account.tier === "ready" || account.tier === "session-starved");
    const [pick, runnerUp] = usable;

    return pick ? { pick, ...(runnerUp ? { runnerUp } : {}) } : undefined;
}
