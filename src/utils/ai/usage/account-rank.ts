import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import {
    type AccountRanker,
    type RankedAccount,
    type RankOptions,
    windowRanker,
} from "@genesiscz/utils/ai/providers/usage-rank";
import { usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";

export {
    type AccountRanker,
    type RankedAccount,
    type RankOptions,
    type RankTier,
    windowRanker,
} from "@genesiscz/utils/ai/providers/usage-rank";

/**
 * Account ranking for every provider (design 2026-11-01 step U4, mobile plan M13 residue). Each provider's usage
 * feature declares its ranker (`AccountUsageFeature.ranker`): Claude its scorer, Codex and Grok the shared
 * `windowRanker`. This module only routes a snapshot to its provider's ranker; no caller compares a provider name.
 */

/** The ranker a provider's usage feature declares; a provider without a usage feature gets the shared window ranker. */
export function rankerFor(provider: string): AccountRanker {
    return usagePlugins().find((entry) => entry.plugin.id === provider)?.usage.ranker ?? windowRanker;
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
