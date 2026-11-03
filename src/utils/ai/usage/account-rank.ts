import {
    type AccountUsageSnapshot,
    absentLimitText,
    hasAbsentLimit,
    type LimitWindow,
} from "@genesiscz/utils/ai/providers/account-features";
import type { PerHarness } from "@genesiscz/utils/ai/providers/alias-list";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { anthropicRanker } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/rank";

/**
 * Account ranking for every provider (design 2026-11-01 step U4, mobile plan M13 residue). One interface, one
 * implementation per provider, reached through `ACCOUNT_RANKERS`: Claude ranks with its scorer, which knows the
 * per-model weekly windows (`anthropic-sub/rank.ts`); Codex and Grok share `windowRanker` below. No caller compares a
 * provider name.
 *
 * `windowRanker`, the shared `auto` account pick (P7) over the provider-neutral usage snapshot:
 * Tiers first: `ready`, then `session-starved` (the short window is spent, the long one is not). A `weekly-blocked`
 * or `no-data` account is never picked: guessing onto a dead account is the failure `auto` exists to prevent. Inside
 * a tier the best share wins: the long window's headroom, plus the part of it that resets unused within a day,
 * divided by 1 + the sessions already on the account, so parallel sessions spread (the idea of switcheroo's
 * `pickCodexRow`).
 */
export type RankTier = "ready" | "session-starved" | "weekly-blocked" | "no-data";

export interface RankedAccount {
    /** Plugin id of the account's provider. */
    provider: string;
    accountId: string;
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
    const base = {
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        accountName: snapshot.accountName,
        sessions,
        resetBonus: 0,
        score: 0,
    };
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
        // No short window at all is no constraint (headroom 100); say so instead of "short 100% left".
        hasAbsentLimit(snapshot, { kind: "session" }) && !short
            ? absentLimitText({ kind: "session" })
            : `${short?.label ?? "short"} ${Math.round(sessionHeadroomPct)}% left`,
        ...(resetBonus > 0 ? [`resets within a day (+${Math.round(resetBonus)})`] : []),
        ...(sessions > 0 ? [`${sessions} session${sessions === 1 ? "" : "s"} on it`] : []),
    ];

    return { ...base, tier, longHeadroomPct, sessionHeadroomPct, resetBonus, score, why: parts.join(", ") };
}

export interface RankOptions {
    /** Open sessions per account name: parallel sessions spread. */
    sessions?: Record<string, number>;
    now?: Date;
}

/** Ranks the accounts of ONE provider, best first. Scores are comparable inside one provider only. */
export interface AccountRanker {
    rank(snapshots: readonly AccountUsageSnapshot[], options: RankOptions): RankedAccount[];
}

/** One long and one short window per account: tier, then share, then short-window headroom, then name. */
export const windowRanker: AccountRanker = {
    rank(snapshots, options) {
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
    },
};

/** The ranker per provider, keyed by its alias: a provider without an entry is a compile error. */
export const ACCOUNT_RANKERS = {
    claude: anthropicRanker,
    codex: windowRanker,
    grok: windowRanker,
} satisfies PerHarness<AccountRanker>;

/** The ranker for a plugin id; a provider the table does not know gets the shared window ranker. */
export function rankerFor(provider: string): AccountRanker {
    const alias = providerAliasOf(provider);

    return isAccountProviderAlias(alias) ? ACCOUNT_RANKERS[alias] : windowRanker;
}

/**
 * Every account ranked by its own provider's ranker, one provider after another in first-seen order. A caller that
 * passes one provider's snapshots gets exactly that provider's order.
 */
export function rankAccounts(snapshots: readonly AccountUsageSnapshot[], options: RankOptions = {}): RankedAccount[] {
    const byProvider = new Map<string, AccountUsageSnapshot[]>();

    for (const snapshot of snapshots) {
        const list = byProvider.get(snapshot.provider) ?? [];
        list.push(snapshot);
        byProvider.set(snapshot.provider, list);
    }

    return [...byProvider.entries()].flatMap(([provider, list]) => rankerFor(provider).rank(list, options));
}

/** The pick and the runner-up among the accounts `auto` may use; undefined when none may be used. */
export function pickRanked(ranked: RankedAccount[]): { pick: RankedAccount; runnerUp?: RankedAccount } | undefined {
    const usable = ranked.filter((account) => account.tier === "ready" || account.tier === "session-starved");
    const [pick, runnerUp] = usable;

    return pick ? { pick, ...(runnerUp ? { runnerUp } : {}) } : undefined;
}
