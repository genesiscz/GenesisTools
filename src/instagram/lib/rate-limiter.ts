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
 * first, so that request never becomes a strike.
 *
 * 🛑 The budget is PER PROCESS and is not persisted. `tools` runs each invocation
 * in its own process, so ten commands in a row each start with a full 75, and
 * back-to-back runs CAN exceed the window that a single run respects. Making this
 * a real account-wide budget needs the timestamps in the tool's storage dir
 * behind an inter-process lock; until then this is an invocation-local throttle
 * and the docs must not promise more than that.
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
    /** Tail of the acquisition chain. See `acquire`. */
    private queue: Promise<void> = Promise.resolve();
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(options: RateLimiterOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? Math.random;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    /** Drop the timestamps that have aged out of the window. The only mutator here. */
    private evictExpired(): void {
        const cutoff = this.now() - WINDOW_MS;
        this.timestamps = this.timestamps.filter((stamp) => stamp > cutoff);
    }

    /** Milliseconds the caller must wait before the next request fits the budget. */
    waitTimeMs(): number {
        this.evictExpired();

        if (this.timestamps.length < MAX_PER_WINDOW) {
            return 0;
        }

        const oldest = this.timestamps[0];
        return Math.max(0, oldest + WINDOW_MS - this.now());
    }

    jitterMs(): number {
        return Math.min(expovariate(JITTER_LAMBDA, this.random) * 1000, JITTER_MAX_MS);
    }

    /**
     * Serialised, because the check and the reservation are separated by two
     * awaits. Without this, concurrent callers all read the same free capacity
     * before any of them records a timestamp, and a `Promise.all` over 76 calls
     * sails past a cap of 75 — the one thing this class exists to prevent.
     */
    async acquire(label: string): Promise<void> {
        const turn = this.queue.then(() => this.acquireExclusive(label));
        // The chain must survive a rejection, or one failed acquire wedges the limiter.
        this.queue = turn.then(
            () => undefined,
            () => undefined
        );
        return turn;
    }

    private async acquireExclusive(label: string): Promise<void> {
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
        return this.timestamps.reduce((count, stamp) => (stamp > cutoff ? count + 1 : count), 0);
    }
}

export const __testing = { WINDOW_MS, MAX_PER_WINDOW, JITTER_MAX_MS };
