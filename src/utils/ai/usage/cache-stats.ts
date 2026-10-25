/**
 * Prompt-cache arithmetic shared by `tools ai-proxy` (sessions, stats, calls), `tools ai-spend` and session-analyzer.
 *
 * One definition of the hit rate everywhere: cache read / (uncached input + cache read + cache write), the
 * session-analyzer definition (GenesisClaude `user/skills/session-analyzer/SKILL.md`, "Cache hit"). Two usage
 * conventions feed it:
 * - Anthropic-shaped (`input_tokens` or `prompt_tokens` plus `cache_read_input_tokens`, `cache_creation_input_tokens`):
 *   the cache counts sit OUTSIDE the input count.
 * - OpenAI-shaped (`prompt_tokens` with `cached_prompt_tokens` from `prompt_tokens_details.cached_tokens` or
 *   Responses `input_tokens_details.cached_tokens`): the cached count is a PART of the prompt count.
 */

/** The prompt-side fields of an ai-proxy usage row (`TokenUsage`), in either convention. */
export interface PromptTokenFields {
    prompt_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cached_prompt_tokens?: number;
}

export interface PromptTokenSplit {
    /** Input the upstream processed in full. */
    uncached: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Split one usage row into uncached input, cache read and cache write, whichever convention it uses. */
export function splitPromptTokens(usage: PromptTokenFields | undefined): PromptTokenSplit {
    const prompt = usage?.prompt_tokens ?? 0;

    if (usage?.cache_read_input_tokens !== undefined || usage?.cache_creation_input_tokens !== undefined) {
        return {
            uncached: prompt,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
        };
    }

    const cached = Math.min(usage?.cached_prompt_tokens ?? 0, prompt);
    return { uncached: prompt - cached, cacheRead: cached, cacheWrite: 0 };
}

/** Cache read as a percent of all input (uncached + read + write); undefined when there was no input at all. */
export function hitPercent(split: PromptTokenSplit): number | undefined {
    const total = split.uncached + split.cacheRead + split.cacheWrite;
    return total > 0 ? (split.cacheRead / total) * 100 : undefined;
}

/** One request of a session, in session-analyzer's `TraceCall` terms (tokens split by {@link splitPromptTokens}). */
export interface CacheCall {
    /** epoch ms */
    t: number;
    model: string;
    /** Uncached input tokens. */
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output?: number;
    /** Cache write lifetime, when the usage says (Anthropic `cache_creation.ephemeral_*`). */
    ttl?: "5m" | "1h" | "mixed";
    /** The prompt cache key the request carried, when known. */
    key?: string;
    /** Claude Code's compaction turn. */
    compaction?: boolean;
}

// Shared with session-analyzer scripts/session-dashboard-shared.ts ctxOf; ported 2026-10-25 from GenesisClaude 937ab1d.
// Keep both copies in step until session-analyzer imports this module.
export const ctxOf = (c: Pick<CacheCall, "input" | "cacheRead" | "cacheWrite">): number =>
    c.input + c.cacheRead + c.cacheWrite;

const r2 = (n: number): number => Math.round(n * 100) / 100;

// Shared with session-analyzer scripts/claude/session-dashboard.ts ttlOf; ported 2026-10-25 from GenesisClaude 937ab1d.
// Keep both copies in step until session-analyzer imports this module.
export function cacheTtlOf(usage: {
    cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}): "5m" | "1h" | "mixed" | undefined {
    const h1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const m5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;

    if (h1 && m5) {
        return "mixed";
    }

    if (h1) {
        return "1h";
    }

    return m5 ? "5m" : undefined;
}

// Shared with session-analyzer scripts/session-dashboard-shared.ts missReason; ported 2026-10-25 from GenesisClaude
// 937ab1d. Keep both copies in step until session-analyzer imports this module.
/** Why the cache missed, from what the session shows around the call. */
export function missReason(c: CacheCall, prev: CacheCall | undefined, compactedSincePrev: boolean): string {
    if (!prev) {
        return "first call of the session (nothing cached yet)";
    }

    if (compactedSincePrev) {
        return "compaction rewrote the conversation";
    }

    if (prev.model !== c.model) {
        return `model changed (${prev.model} to ${c.model})`;
    }

    const gapMin = (c.t - prev.t) / 60_000;

    if (gapMin > 60) {
        return `idle ${Math.round(gapMin)} min: past the 1 h cache lifetime`;
    }

    if (gapMin > 5 && c.ttl !== "1h") {
        return `idle ${Math.round(gapMin)} min: past the 5 min cache lifetime`;
    }

    return "prefix changed (tools, system prompt or an edited earlier message)";
}

/** A call whose prompt was mostly written to the cache again, or sent uncached, rather than read from it. */
export interface CacheMiss {
    call: number;
    t: number;
    ctx: number;
    /** Tokens the call did not read from the cache: written (Anthropic) or sent uncached (Codex, Grok). */
    written: number;
    /** Minutes since the previous call. */
    gapMin: number | null;
    reason: string;
}

// Shared with session-analyzer scripts/session-dashboard-shared.ts findMisses; ported 2026-10-25 from GenesisClaude
// 937ab1d (takes the calls instead of a SessionTrace; a call's own `compaction` flag replaces the compaction list).
// Keep both copies in step until session-analyzer imports this module.
/** Misses: a call where at least `minTokens` and at least `minShare` of its prompt did not come from the cache. */
export function findMisses(calls: CacheCall[], minTokens = 20_000, minShare = 0.3): CacheMiss[] {
    const out: CacheMiss[] = [];

    for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const prev = calls[i - 1];
        const ctx = ctxOf(c);
        const missed = c.cacheWrite + c.input;

        if (missed < minTokens || missed < minShare * ctx) {
            continue;
        }

        out.push({
            call: i,
            t: c.t,
            ctx,
            written: missed,
            gapMin: prev ? r2((c.t - prev.t) / 60_000) : null,
            reason: missReason(c, prev, prev?.compaction === true),
        });
    }

    return out;
}

/** A request whose cache read fell sharply against the previous request of the same session. */
export interface CacheLoss {
    call: number;
    t: number;
    /** Cache read of the previous request, then of this one. */
    before: number;
    after: number;
    gapMin: number;
    cause: "key changed" | "model changed" | "compaction" | "idle" | "unknown";
    reason: string;
}

/**
 * Cache losses: the cache read dropped by more than `minShare` (default 50%) and by at least `minTokens` (default
 * 2,048) against the previous request. Ordered calls of ONE session or thread; never pair a main loop with a
 * subagent. The cause is the first that applies: the key changed, the model changed, the previous request was a
 * compaction, the gap passed the cache lifetime, else unknown.
 */
export function findCacheLosses(calls: CacheCall[], minShare = 0.5, minTokens = 2_048): CacheLoss[] {
    const out: CacheLoss[] = [];

    for (let i = 1; i < calls.length; i++) {
        const c = calls[i];
        const prev = calls[i - 1];
        const fell = prev.cacheRead - c.cacheRead;

        if (fell < minTokens || fell <= minShare * prev.cacheRead) {
            continue;
        }

        const gapMin = r2((c.t - prev.t) / 60_000);
        let cause: CacheLoss["cause"] = "unknown";

        if (prev.key !== undefined && c.key !== undefined && prev.key !== c.key) {
            cause = "key changed";
        } else if (prev.model !== c.model) {
            cause = "model changed";
        } else if (prev.compaction) {
            cause = "compaction";
        } else if (gapMin > 60 || (gapMin > 5 && c.ttl !== "1h")) {
            cause = "idle";
        }

        const reason =
            cause === "key changed"
                ? `cache key changed (${prev.key} to ${c.key})`
                : missReason(c, prev, prev.compaction === true);
        out.push({ call: i, t: c.t, before: prev.cacheRead, after: c.cacheRead, gapMin, cause, reason });
    }

    return out;
}

export interface CacheSummary {
    requests: number;
    uncached: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    /** Over the whole list: read / (uncached + read + write). */
    hitPercent: number | undefined;
    /** Per-request hit %, for the spread. */
    p10: number | undefined;
    median: number | undefined;
    p90: number | undefined;
    losses: number;
}

function quantile(sorted: number[], q: number): number | undefined {
    if (sorted.length === 0) {
        return undefined;
    }

    const at = (sorted.length - 1) * q;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Totals, hit % and its spread for one list of calls (one session, or a pool of requests). */
export function summarizeCache(calls: CacheCall[], losses = findCacheLosses(calls).length): CacheSummary {
    const totals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const perRequest: number[] = [];

    for (const c of calls) {
        totals.uncached += c.input;
        totals.cacheRead += c.cacheRead;
        totals.cacheWrite += c.cacheWrite;
        totals.output += c.output ?? 0;
        const hit = hitPercent({ uncached: c.input, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite });

        if (hit !== undefined) {
            perRequest.push(hit);
        }
    }

    perRequest.sort((a, b) => a - b);

    return {
        requests: calls.length,
        ...totals,
        hitPercent: hitPercent({
            uncached: totals.uncached,
            cacheRead: totals.cacheRead,
            cacheWrite: totals.cacheWrite,
        }),
        p10: quantile(perRequest, 0.1),
        median: quantile(perRequest, 0.5),
        p90: quantile(perRequest, 0.9),
        losses,
    };
}
