import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import { type RankedAccount, type RankOptions, rankAccounts } from "./account-rank";
import type { AccountForecast } from "./forecast/forecast";

/**
 * The account advisor (design 2026-11-01 step U4, proposal 6): which account to use next per workload, how long it
 * lasts at its recent burn, and the long-window capacity that will go unused at each reset. A pure function over the
 * snapshots and the forecasts; every provider ranks through `rankAccounts`, so nothing here names a provider.
 */

/** `usage.limits.advise@1`: the verb and its shape version. */
export const LIMITS_ADVISE_SCHEMA = { verb: "limits.advise", version: 1 } as const;

/** A workload's order over the usable accounts of one provider, best first. */
type ProfileOrder = (
    rows: readonly RankedAccount[],
    snapshots: ReadonlyMap<string, AccountUsageSnapshot>
) => RankedAccount[];

const LONG_KINDS: ReadonlySet<LimitWindow["kind"]> = new Set(["weekly", "monthly"]);
const DAY_MS = 24 * 3_600_000;

function longWindow(snapshot: AccountUsageSnapshot | undefined): LimitWindow | undefined {
    return snapshot?.limits.find((window) => LONG_KINDS.has(window.kind) && !window.scopeModel);
}

function daysToReset(window: LimitWindow | undefined, now: number): number {
    const resetMs = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return Number.isFinite(resetMs) && resetMs > now ? (resetMs - now) / DAY_MS : 7;
}

function stableSort(rows: readonly RankedAccount[], key: (row: RankedAccount) => number): RankedAccount[] {
    return rows
        .map((row, index) => ({ row, index, value: key(row) }))
        .sort((a, b) => b.value - a.value || a.index - b.index)
        .map((entry) => entry.row);
}

function profilesAt(now: number): Record<AdviseProfileId, ProfileOrder> {
    return {
        /** The provider's own ranking. */
        default: (rows) => [...rows],
        /** Many parallel sessions: the most 5-hour headroom, an account without a 5-hour limit first. */
        "fan-out": (rows, snapshots) =>
            stableSort(rows, (row) =>
                snapshots.get(row.accountId)?.absentLimits?.some((limit) => limit.kind === "session")
                    ? 101
                    : row.sessionHeadroomPct
            ),
        /** One long run: the long window's headroom per day left until it resets. */
        "long-run": (rows, snapshots) =>
            stableSort(
                rows,
                (row) =>
                    row.longHeadroomPct / Math.max(daysToReset(longWindow(snapshots.get(row.accountId)), now), 1 / 24)
            ),
    };
}

export type AdviseProfileId = "default" | "fan-out" | "long-run";

export const ADVISE_PROFILE_IDS: readonly AdviseProfileId[] = ["default", "fan-out", "long-run"];

export interface AdviceRow {
    provider: string;
    accountId: string;
    accountName: string;
    tier: RankedAccount["tier"];
    why: string;
    /** Minutes until the first window runs out before its reset, at the recent burn; null when none does. */
    lastsMinutes: number | null;
    /** The label of that window. */
    bindingLabel: string | null;
}

export interface ProfileAdvice {
    /** `default`, `fan-out`, `long-run`, or `model:<name>` for a model's own weekly window. */
    profile: string;
    pick: AdviceRow | null;
    runnerUp: AdviceRow | null;
}

export interface UnusedAtReset {
    provider: string;
    accountId: string;
    accountName: string;
    key: string;
    label: string;
    resetsAt: string;
    /** Percent of the window the recent burn leaves unused at the reset. */
    unusedPct: number;
}

export interface ProviderAdvice {
    provider: string;
    profiles: ProfileAdvice[];
    /** Soonest reset first: the account whose headroom expires first should take the work. */
    unusedAtReset: UnusedAtReset[];
}

export interface AdviseData {
    providers: ProviderAdvice[];
}

export interface AdviseInput {
    snapshots: readonly AccountUsageSnapshot[];
    /** `forecastFromSamples` over the same accounts; matched on provider and account name. */
    forecasts: readonly AccountForecast[];
    /** Extra `model:<name>` profiles: rank by that model's own weekly window. */
    models?: readonly string[];
    rank?: RankOptions;
    now?: Date;
}

function forecastKey(provider: string, accountName: string): string {
    return `${provider}\u0000${accountName}`;
}

function lastsOf(forecast: AccountForecast | undefined): Pick<AdviceRow, "lastsMinutes" | "bindingLabel"> {
    const binding = (forecast?.windows ?? [])
        .filter((window) => window.beforeReset && window.minutesToExhaust !== null)
        .sort((a, b) => (a.minutesToExhaust ?? 0) - (b.minutesToExhaust ?? 0))[0];

    return { lastsMinutes: binding?.minutesToExhaust ?? null, bindingLabel: binding?.label ?? null };
}

function modelOrder(model: string): ProfileOrder {
    const wanted = model.toLowerCase();
    const scoped = (snapshot: AccountUsageSnapshot | undefined) =>
        snapshot?.limits.find((window) => window.scopeModel?.toLowerCase().includes(wanted));

    return (rows, snapshots) => {
        const carrying = rows.filter((row) => scoped(snapshots.get(row.accountId)) !== undefined);
        return stableSort(carrying, (row) => 100 - (scoped(snapshots.get(row.accountId))?.percentUsed ?? 100));
    };
}

function unusedOf(forecasts: readonly AccountForecast[], ids: ReadonlyMap<string, string>): UnusedAtReset[] {
    return forecasts
        .flatMap((account) =>
            account.windows
                .filter(
                    (window) =>
                        window.kind !== "session" &&
                        !window.stale &&
                        !window.resetSinceSample &&
                        window.resetsAt !== null &&
                        window.projectedAtReset !== null &&
                        window.projectedAtReset < 100
                )
                .map((window) => ({
                    provider: account.provider,
                    accountId: ids.get(forecastKey(account.provider, account.account)) ?? account.account,
                    accountName: account.account,
                    key: window.bucket,
                    label: window.label,
                    resetsAt: window.resetsAt ?? "",
                    unusedPct: Math.round((100 - (window.projectedAtReset ?? 100)) * 10) / 10,
                }))
        )
        .sort((a, b) => a.resetsAt.localeCompare(b.resetsAt));
}

/** Per provider: the next account for each workload, and the capacity each long window leaves unused. */
export function adviseAccounts(input: AdviseInput): AdviseData {
    const now = (input.now ?? new Date()).getTime();
    const ranked = rankAccounts(input.snapshots, { ...input.rank, ...(input.now ? { now: input.now } : {}) });
    const forecasts = new Map(
        input.forecasts.map((account) => [forecastKey(account.provider, account.account), account])
    );
    const snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.accountId, snapshot]));
    const ids = new Map(
        input.snapshots.map((snapshot) => [forecastKey(snapshot.provider, snapshot.accountName), snapshot.accountId])
    );
    const profiles: Array<[string, ProfileOrder]> = [
        ...Object.entries(profilesAt(now)),
        ...(input.models ?? []).map((model): [string, ProfileOrder] => [`model:${model}`, modelOrder(model)]),
    ];
    const providers = [...new Set(ranked.map((row) => row.provider))];

    return {
        providers: providers.map((provider) => {
            const usable = ranked.filter(
                (row) => row.provider === provider && (row.tier === "ready" || row.tier === "session-starved")
            );
            const toAdvice = (row: RankedAccount | undefined): AdviceRow | null =>
                row
                    ? {
                          provider: row.provider,
                          accountId: row.accountId,
                          accountName: row.accountName,
                          tier: row.tier,
                          why: row.why,
                          ...lastsOf(forecasts.get(forecastKey(row.provider, row.accountName))),
                      }
                    : null;

            return {
                provider,
                profiles: profiles.map(([profile, order]) => {
                    const [pick, runnerUp] = order(usable, snapshots);
                    return { profile, pick: toAdvice(pick), runnerUp: toAdvice(runnerUp) };
                }),
                unusedAtReset: unusedOf(
                    input.forecasts.filter((account) => account.provider === provider),
                    ids
                ),
            };
        }),
    };
}
