import { logger } from "@genesiscz/utils/logger";

/**
 * In-memory per-account cooldown registry, shared by subscription providers.
 * Keys are account names (or token fingerprints). Rate limits back off
 * exponentially on consecutive strikes; any success resets the state.
 */
interface CooldownState {
    until: number;
    strikes: number;
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;
export const UNHEALTHY_COOLDOWN_MS = 15 * 60_000;

const cooldowns = new Map<string, CooldownState>();

/** Apply a 429 cooldown. Honours Retry-After when given; else exponential backoff. Returns the window in ms. */
export function markRateLimited(key: string, retryAfterSec?: number): number {
    const previous = cooldowns.get(key);
    const strikes = (previous?.strikes ?? 0) + 1;
    const backoffMs =
        retryAfterSec != null && Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : Math.min(BASE_BACKOFF_MS * 2 ** (strikes - 1), MAX_BACKOFF_MS);

    cooldowns.set(key, { until: Date.now() + backoffMs, strikes });
    logger.warn({ key, strikes, backoffMs }, "ai-proxy cooldown: rate limited, cooling down");

    return backoffMs;
}

/** Mark an account unusable (e.g. auth dead after refresh) for a fixed window. */
export function markUnhealthy(key: string, ms: number = UNHEALTHY_COOLDOWN_MS): void {
    const previous = cooldowns.get(key);
    cooldowns.set(key, { until: Date.now() + ms, strikes: previous?.strikes ?? 0 });
    logger.warn({ key, ms }, "ai-proxy cooldown: account marked unhealthy");
}

export function markSuccess(key: string): void {
    cooldowns.delete(key);
}

export function cooldownRemainingMs(key: string): number {
    const state = cooldowns.get(key);

    if (!state) {
        return 0;
    }

    const remaining = state.until - Date.now();
    if (remaining <= 0) {
        return 0;
    }

    return remaining;
}

/** Test hook: wipe all cooldown state. */
export function resetCooldowns(): void {
    cooldowns.clear();
}
