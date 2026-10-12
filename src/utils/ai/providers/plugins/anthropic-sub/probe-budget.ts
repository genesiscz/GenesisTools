import { USAGE_CACHE_TTL, usageCacheFilePath, usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import { logger } from "@genesiscz/utils/logger";

/**
 * A quota probe is a real inference request, so every probe spends a little of the account's own limits.
 * The budget counts the probes per account and model over the last 7 days and refuses the one that would
 * go over the cap. It is the guard above the spending call: a cadence bug, or many processes polling at
 * once, can make probes more frequent, never more than the cap.
 */

const LEDGER_KEY = "probe-budget:anthropic-sub";
const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const LOCK_TIMEOUT_MS = 10_000;

/** account → model → UTC day (YYYY-MM-DD) → probes sent that day. */
type Ledger = Record<string, Record<string, Record<string, number>>>;

export class ProbeBudgetExceeded extends Error {
    constructor(
        readonly account: string,
        readonly model: string,
        readonly spent: number,
        readonly cap: number
    ) {
        super(`the quota probe budget is spent: ${spent} of ${cap} ${model} probes in 7 days for ${account}`);
        this.name = "ProbeBudgetExceeded";
    }
}

export interface ProbeBudget {
    /** Counts one probe of `model`; throws ProbeBudgetExceeded, and counts nothing, when the cap is reached. */
    spend(model: string): Promise<void>;
}

function dayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/** The days of the rolling 7-day window, older days dropped. */
export function daysInWindow(days: Readonly<Record<string, number>> | undefined, now: number): Record<string, number> {
    const oldest = dayOf(now - (WINDOW_DAYS - 1) * DAY_MS);
    return Object.fromEntries(Object.entries(days ?? {}).filter(([day]) => day >= oldest));
}

export function probesInWindow(days: Readonly<Record<string, number>> | undefined, now: number): number {
    return Object.values(daysInWindow(days, now)).reduce((sum, count) => sum + count, 0);
}

interface PendingSpend {
    account: string;
    model: string;
    cap: number;
    resolve: () => void;
    reject: (error: unknown) => void;
}

/** Spends waiting for the next commit; a spend that arrives while one commit runs joins the next. */
let gathering: PendingSpend[] | null = null;
let commits: Promise<void> = Promise.resolve();

/**
 * One lock, one read and one write for every spend that arrived together. A round polls every account at once
 * and each spends before its probe: a lock per spend queued the accounts behind each other, 2-3 s each while the
 * disk stalled, so the later ones passed the 10 s lock wait and a round took the sum of the critical sections.
 * A spend resolves only after the write that counts it, so the budget still guards the probe that follows.
 */
async function commitSpends(batch: PendingSpend[]): Promise<void> {
    const accepted: PendingSpend[] = [];

    try {
        const storage = usagePollStorage();
        await storage.withFileLock({
            file: usageCacheFilePath(LEDGER_KEY),
            fn: async () => {
                const now = Date.now();
                const today = dayOf(now);
                const ledger = (await storage.getCacheFile<Ledger>(LEDGER_KEY, USAGE_CACHE_TTL)) ?? {};

                for (const spend of batch) {
                    const days = daysInWindow(ledger[spend.account]?.[spend.model], now);
                    const spent = probesInWindow(days, now);

                    if (spent >= spend.cap) {
                        logger.warn(
                            { account: spend.account, model: spend.model, spent, cap: spend.cap },
                            "[usage] quota probe refused: the budget is spent"
                        );
                        spend.reject(new ProbeBudgetExceeded(spend.account, spend.model, spent, spend.cap));
                        continue;
                    }

                    days[today] = (days[today] ?? 0) + 1;
                    ledger[spend.account] = { ...ledger[spend.account], [spend.model]: days };
                    accepted.push(spend);
                }

                if (accepted.length > 0) {
                    await storage.putCacheFile(LEDGER_KEY, ledger, USAGE_CACHE_TTL);
                }
            },
            timeout: LOCK_TIMEOUT_MS,
        });
    } catch (error) {
        // Nothing of this batch was recorded, so every spend is refused with the cause; one already refused stays as it was.
        for (const spend of batch) {
            spend.reject(error);
        }

        return;
    }

    for (const spend of accepted) {
        spend.resolve();
    }
}

function enqueueSpend(spend: Pick<PendingSpend, "account" | "model" | "cap">): Promise<void> {
    return new Promise((resolve, reject) => {
        if (gathering) {
            gathering.push({ ...spend, resolve, reject });
            return;
        }

        const batch: PendingSpend[] = [{ ...spend, resolve, reject }];
        gathering = batch;
        commits = commits.then(() => {
            gathering = null;
            return commitSpends(batch);
        });
    });
}

/**
 * The budget kept in `~/.genesis-tools/ai-usage/`, shared by every process that polls (the daemon, the
 * TUI, the dashboard) under one file lock. A lock that cannot be taken refuses the probe as well.
 */
export function persistedProbeBudget(account: string, caps: Readonly<Record<string, number>>): ProbeBudget {
    return {
        async spend(model) {
            const cap = caps[model];

            if (cap === undefined) {
                throw new Error(`no quota probe budget is set for ${model}`);
            }

            await enqueueSpend({ account, model, cap });
        },
    };
}
