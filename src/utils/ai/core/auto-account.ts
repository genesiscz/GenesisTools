import { logger } from "@genesiscz/utils/logger";
import { APICallError, RetryError } from "ai";
import { AiConfigStore } from "../config/AiConfigStore";
import type { AccountEntry } from "../config/schema";
import type { AccountUsageSnapshot, LimitWindow } from "../providers/account-features";
import { pollAccounts } from "../usage-poll/poll";
import { ModelResolutionError, resolveModelTarget } from "./resolve";
import type { ResolvedBinding, ResolvedTarget, ResolveOptions } from "./types";

/**
 * `--account auto`: pick the subscription account with the most room left, and move to the next one when an
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

function appliesTo(window: LimitWindow, modelId: string): boolean {
    if (window.kind === "credit") {
        return false;
    }

    return !window.scopeModel || modelId.toLowerCase().includes(window.scopeModel.toLowerCase());
}

function describe(windows: LimitWindow[]): string {
    return windows.map((window) => `${window.label} ${Math.round(window.percentUsed)}%`).join(", ");
}

/**
 * Order subscription targets by usage room. Accounts with usage data come first (least used first), then the ones
 * with none, then the ones whose window is full; ties keep config order. Pure, so a test needs no network.
 */
export function rankAutoAccounts(
    targets: readonly ResolvedTarget[],
    snapshots: readonly AccountUsageSnapshot[]
): AutoCandidate[] {
    const byAccount = new Map(snapshots.map((snapshot) => [snapshot.accountId, snapshot]));
    const candidates = targets.map((target, index) => {
        const windows = (byAccount.get(target.account.id)?.limits ?? []).filter(
            (window) => typeof window.percentUsed === "number" && appliesTo(window, target.model.id)
        );

        if (windows.length === 0) {
            return { index, candidate: { target, why: "no usage data" } satisfies AutoCandidate };
        }

        const usedPct = Math.max(...windows.map((window) => window.percentUsed));
        const why = `${describe(windows)} used${usedPct >= 100 ? " (full)" : ""}`;
        return { index, candidate: { target, usedPct, why } satisfies AutoCandidate };
    });
    const rank = (candidate: AutoCandidate): number => {
        if (candidate.usedPct === undefined) {
            return 100;
        }

        return candidate.usedPct >= 100 ? 200 + candidate.usedPct : candidate.usedPct;
    };

    return candidates
        .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
        .map((entry) => entry.candidate);
}

export interface AutoAccountOptions {
    task?: ResolveOptions["task"];
    /** A bare model (`sonnet`, `claude-opus-5-5`) every account should serve; omitted means each provider's default. */
    model?: string;
    store?: AiConfigStore;
    /** Injected usage, for tests. Omitted reads the shared usage cache (`tools ai usage`), polling when stale. */
    snapshots?: readonly AccountUsageSnapshot[];
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
    return rankAutoAccounts(targets, snapshots);
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
        const rank = index === 0 ? `most room of ${candidates.length} subscription accounts` : "next in line";
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
