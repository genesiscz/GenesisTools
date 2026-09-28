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

            const storage = usagePollStorage();
            await storage.withFileLock({
                file: usageCacheFilePath(LEDGER_KEY),
                fn: async () => {
                    const now = Date.now();
                    const ledger = (await storage.getCacheFile<Ledger>(LEDGER_KEY, USAGE_CACHE_TTL)) ?? {};
                    const days = daysInWindow(ledger[account]?.[model], now);
                    const spent = probesInWindow(days, now);

                    if (spent >= cap) {
                        logger.warn({ account, model, spent, cap }, "[usage] quota probe refused: the budget is spent");
                        throw new ProbeBudgetExceeded(account, model, spent, cap);
                    }

                    const today = dayOf(now);
                    days[today] = (days[today] ?? 0) + 1;
                    ledger[account] = { ...ledger[account], [model]: days };
                    await storage.putCacheFile(LEDGER_KEY, ledger, USAGE_CACHE_TTL);
                },
                timeout: LOCK_TIMEOUT_MS,
            });
        },
    };
}
