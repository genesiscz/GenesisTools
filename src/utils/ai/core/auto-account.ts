import { logger } from "@genesiscz/utils/logger";
import { APICallError, RetryError } from "ai";
import { AiConfigStore } from "../config/AiConfigStore";
import type { AccountEntry } from "../config/schema";
import type { AccountUsageSnapshot, LimitWindow } from "../providers/account-features";
import { pollAccounts } from "../usage-poll/poll";
import { ModelResolutionError, resolveModelTarget } from "./resolve";
import type { ResolvedBinding, ResolvedTarget, ResolveOptions } from "./types";

/**
 * `--account auto`: pick a subscription account by provider order (Claude, Codex, Grok) among those with weekly room
 * left, and move to the next one when an
 * account refuses. Paid accounts never enter the list: spending money is something a user names, not something
 * a ranking decides.
 */

const { log } = logger.scoped("ai-auto");

/** A refusal another account can get past: rate or plan limit, expired login, an org that blocks the call. */
const SWITCH_STATUS = new Set([401, 403, 429]);

export interface AutoCandidate {
    target: ResolvedTarget;
    /** Highest used percent of the windows that apply to the model; undefined without usage data. */
    usedPct?: number;
    /** One line: what the ranking saw for this account. */
    why: string;
}

/** Which subscriptions to spend first, and how much weekly room an account must keep to count as usable. */
export interface AutoPolicy {
    /** Plugin ids, best first; a provider not listed comes after the listed ones. */
    providerOrder: readonly string[];
    /** An account with this much weekly room or less waits until no other account is usable. */
    minWeeklyLeftPct: number;
}

/** Martin, 2026-10-19: "claude better, then codex, then grok, whenever > 10% weekly left". */
export const DEFAULT_AUTO_POLICY: AutoPolicy = {
    providerOrder: ["anthropic-sub", "openai-sub", "grok-sub"],
    minWeeklyLeftPct: 10,
};

function appliesTo(window: LimitWindow, modelId: string): boolean {
    if (window.kind === "credit") {
        return false;
    }

    return !window.scopeModel || modelId.toLowerCase().includes(window.scopeModel.toLowerCase());
}

function describe(windows: LimitWindow[]): string {
    return windows.map((window) => `${window.label} ${Math.round(window.percentUsed)}%`).join(", ");
}

/** Usable first, then unknown, then low on weekly room, then full. */
type Tier = 0 | 1 | 2 | 3;

/**
 * Order subscription targets. A usable account (usage data, no full window, more than `minWeeklyLeftPct` weekly
 * room) comes first, by provider order and then by the least used window. Then accounts without usage data, then
 * accounts low on weekly room, then full ones. Ties keep config order. Pure, so a test needs no network.
 */
export function rankAutoAccounts(
    targets: readonly ResolvedTarget[],
    snapshots: readonly AccountUsageSnapshot[],
    policy: AutoPolicy = DEFAULT_AUTO_POLICY
): AutoCandidate[] {
    const byAccount = new Map(snapshots.map((snapshot) => [snapshot.accountId, snapshot]));
    const providerRank = (provider: string): number => {
        const index = policy.providerOrder.indexOf(provider);
        return index === -1 ? policy.providerOrder.length : index;
    };
    const ranked = targets.map((target, index) => {
        const windows = (byAccount.get(target.account.id)?.limits ?? []).filter(
            (window) => typeof window.percentUsed === "number" && appliesTo(window, target.model.id)
        );

        if (windows.length === 0) {
            return { index, tier: 1 as Tier, candidate: { target, why: "no usage data" } satisfies AutoCandidate };
        }

        const usedPct = Math.max(...windows.map((window) => window.percentUsed));
        const weekly = windows.filter((window) => window.kind === "weekly" || window.kind === "scoped");
        const weeklyLeftPct = 100 - Math.max(0, ...weekly.map((window) => window.percentUsed));
        const tier: Tier = usedPct >= 100 ? 3 : weeklyLeftPct <= policy.minWeeklyLeftPct ? 2 : 0;
        const note = ["", "", ` (${policy.minWeeklyLeftPct}% weekly room or less)`, " (full)"][tier];
        return {
            index,
            tier,
            candidate: { target, usedPct, why: `${describe(windows)} used${note}` } satisfies AutoCandidate,
        };
    });

    return ranked
        .sort(
            (a, b) =>
                a.tier - b.tier ||
                (a.tier <= 1
                    ? providerRank(a.candidate.target.account.provider) -
                      providerRank(b.candidate.target.account.provider)
                    : 0) ||
                (a.candidate.usedPct ?? 0) - (b.candidate.usedPct ?? 0) ||
                a.index - b.index
        )
        .map((entry) => entry.candidate);
}

export interface AutoAccountOptions {
    task?: ResolveOptions["task"];
    /** A bare model (`sonnet`, `claude-opus-5-5`) every account should serve; omitted means each provider's default. */
    model?: string;
    store?: AiConfigStore;
    /** Injected usage, for tests. Omitted reads the shared usage cache (`tools ai usage`), polling when stale. */
    snapshots?: readonly AccountUsageSnapshot[];
    policy?: AutoPolicy;
}

async function readUsage(accounts: readonly AccountEntry[]): Promise<AccountUsageSnapshot[]> {
    try {
        // probe: never rotate or spend a single-use refresh token just to rank.
        return await pollAccounts({
            providers: [...new Set(accounts.map((account) => account.provider))],
            accountFilter: accounts.map((account) => account.name),
            probe: true,
        });
    } catch (error) {
        log.warn({ error }, "auto account: usage unavailable, keeping config order");
        return [];
    }
}

/** Every enabled subscription account that can serve the task, ranked. Resolves only: nothing is bound. */
export async function autoAccountCandidates(options: AutoAccountOptions = {}): Promise<AutoCandidate[]> {
    const store = options.store ?? (await AiConfigStore.load());
    const task = options.task ?? "chat";
    const targets: ResolvedTarget[] = [];

    for (const account of store.accounts({ billing: "subscription", enabled: true })) {
        const ref = options.model ? `@account/${account.id}:${options.model}` : `@account/${account.id}`;

        try {
            targets.push(await resolveModelTarget(ref, { task, store }));
        } catch (error) {
            if (!(error instanceof ModelResolutionError)) {
                throw error;
            }

            log.debug({ account: account.name, error: error.message }, "auto account: cannot serve the task");
        }
    }

    const snapshots = options.snapshots ?? (await readUsage(targets.map((target) => target.account)));
    return rankAutoAccounts(targets, snapshots, options.policy);
}

/** A refusal that a different account may not get: 401, 403 or 429, also when the SDK wrapped it in retries. */
export function isAccountRefusal(error: unknown): boolean {
    const cause = RetryError.isInstance(error) ? error.lastError : error;
    return APICallError.isInstance(cause) && cause.statusCode !== undefined && SWITCH_STATUS.has(cause.statusCode);
}

function refusalText(error: unknown): string {
    const cause = RetryError.isInstance(error) ? error.lastError : error;
    return APICallError.isInstance(cause) ? `${cause.statusCode}: ${cause.message}` : String(error);
}

export interface RunWithAutoAccountOptions<T> {
    candidates: readonly AutoCandidate[];
    /** Who asks, for the log line (`domains`). */
    app: string;
    run: (resolved: ResolvedBinding) => Promise<T>;
}

/**
 * Run `run` on the best candidate; when an account refuses (401, 403, 429), say so and try the next. Every pick
 * and every switch is told on stderr and in the day log, with the reason. The last refusal is rethrown.
 */
export async function runWithAutoAccount<T>(options: RunWithAutoAccountOptions<T>): Promise<T> {
    const { candidates, app } = options;
    let lastError: unknown;

    for (const [index, candidate] of candidates.entries()) {
        const { account, model } = candidate.target;
        const rank = `pick ${index + 1} of ${candidates.length}: Claude, then Codex, then Grok, with weekly room left`;
        log.tee.log.info(`${app}: AI account "${account.name}" (${model.id}): ${candidate.why}; ${rank}`);

        const binding = await candidate.target.plugin.bind({ account });

        try {
            return await options.run({ ...candidate.target, binding });
        } catch (error) {
            if (!isAccountRefusal(error)) {
                throw error;
            }

            lastError = error;
            log.tee.log.warn(
                `${app}: AI account "${account.name}" refused (${refusalText(error)}); trying the next one`
            );
        } finally {
            await binding.dispose?.();
        }
    }

    throw lastError ?? new ModelResolutionError(`${app}: no subscription account can serve this call`);
}
