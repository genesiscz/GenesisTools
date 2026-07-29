import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("instagram:rate");

/**
 * Proactive request budget, with the numbers taken from instaloader's
 * `RateController` (`instaloader/instaloadercontext.py`) — the only genuinely
 * measured, shipped rate limiter for this API that the research surfaced.
 *
 * Proactive matters: instagrapi's approach is a flat jittered delay plus reactive
 * backoff once a 429 arrives, which means you only learn you were too fast after
 * Instagram has already counted it against you. A budget refuses the request
 * first, so the account never accrues the strike.
 */
const WINDOW_MS = 11 * 60 * 1000;
const MAX_PER_WINDOW = 75;

/** Instaloader's per-request jitter: `min(expovariate(0.6), 15)` seconds. */
const JITTER_LAMBDA = 0.6;
const JITTER_MAX_MS = 15_000;

function expovariate(lambda: number, random: () => number): number {
    return -Math.log(1 - random()) / lambda;
}

export interface RateLimiterOptions {
    /** Injected so tests are deterministic; production uses the real clock. */
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
    private timestamps: number[] = [];
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(options: RateLimiterOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? Math.random;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    /** Milliseconds the caller must wait before the next request fits the budget. */
    waitTimeMs(): number {
        const cutoff = this.now() - WINDOW_MS;
        this.timestamps = this.timestamps.filter((stamp) => stamp > cutoff);

        if (this.timestamps.length < MAX_PER_WINDOW) {
            return 0;
        }

        const oldest = this.timestamps[0];
        return Math.max(0, oldest + WINDOW_MS - this.now());
    }

    jitterMs(): number {
        return Math.min(expovariate(JITTER_LAMBDA, this.random) * 1000, JITTER_MAX_MS);
    }

    async acquire(label: string): Promise<void> {
        const wait = this.waitTimeMs();

        if (wait > 0) {
            log.warn(
                { label, waitMs: wait, used: this.timestamps.length, max: MAX_PER_WINDOW },
                "request budget exhausted — sleeping before the next Instagram call"
            );
            await this.sleep(wait);
        }

        const jitter = this.jitterMs();
        if (jitter > 0) {
            log.debug({ label, jitterMs: Math.round(jitter) }, "jittering before request");
            await this.sleep(jitter);
        }

        this.timestamps.push(this.now());
    }

    get used(): number {
        const cutoff = this.now() - WINDOW_MS;
        return this.timestamps.filter((stamp) => stamp > cutoff).length;
    }
}

export const __testing = { WINDOW_MS, MAX_PER_WINDOW, JITTER_MAX_MS };
