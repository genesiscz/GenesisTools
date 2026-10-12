/**
 * The prompt-cache clock of a session, from the time of its last cached turn. Its own small module, so a cheap
 * reader (the cached session list) can bring the clocks up to date without loading the listing code.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000; // Claude Code 1-hour prompt-cache TTL
export const CODEX_CACHE_TTL_MS = 30 * 60 * 1000; // GPT-5.6+ / Codex subscription documented minimum
export const GROK_CACHE_TTL_MS = 30 * 60 * 1000; // warning clock; xAI publishes no TTL (eviction anytime)
export const COOLING_REMAINING_MS = 10 * 60 * 1000;
export const CRITICAL_REMAINING_MS = 5 * 60 * 1000;
export const COOLING_THRESHOLD_MS = CACHE_TTL_MS - COOLING_REMAINING_MS; // 50 min idle = 10 min left
export const CRITICAL_THRESHOLD_MS = CACHE_TTL_MS - CRITICAL_REMAINING_MS; // 55 min idle = 5 min left

export type CacheStatus = "HOT" | "COOLING" | "CRITICAL" | "COLD";

export function computeCacheStatus(
    cacheAt: number,
    now: number,
    ttlMs: number = CACHE_TTL_MS
): { status: CacheStatus; ttlSec: number } {
    const elapsed = now - cacheAt;
    const ttlRemaining = Math.max(0, ttlMs - elapsed);
    const ttlSec = Math.ceil(ttlRemaining / 1000);

    if (elapsed >= ttlMs) {
        return { status: "COLD", ttlSec: 0 };
    }

    if (ttlRemaining <= CRITICAL_REMAINING_MS) {
        return { status: "CRITICAL", ttlSec };
    }

    if (ttlRemaining <= COOLING_REMAINING_MS) {
        return { status: "COOLING", ttlSec };
    }

    return { status: "HOT", ttlSec };
}
